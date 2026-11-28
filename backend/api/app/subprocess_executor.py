"""
SubprocessExecutor – launches worker_host.py as a child process and
communicates over the line-delimited JSON protocol.

One executor instance is reusable across runs; each call to run() spawns a
fresh worker, waits for completion (or cancellation), and cleans up.
"""
import json
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional


_WORKER_SCRIPT = str(Path(__file__).parent / "worker_host.py")


class SubprocessExecutor:
    def __init__(self, python_executable: str):
        self.python_executable = python_executable

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def run(
        self,
        run_obj,
        model_dir: str,
        entry: str = "generator.py",
        *args,
        **kwargs,
    ) -> Any:
        """Launch a worker, execute a single run, and return the output path.

        Blocks until the worker signals *result* or *error*, or the run is
        cancelled.  On return the subprocess is guaranteed to be dead.
        """
        cmd = [
            self.python_executable, "-u", _WORKER_SCRIPT,
            "--model-dir", model_dir,
            "--entry", entry,
        ]
        creation_flags = (
            subprocess.CREATE_NO_WINDOW
            if hasattr(subprocess, "CREATE_NO_WINDOW")
            else 0
        )
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=creation_flags,
            text=False,
        )
        try:
            return self._drive(proc, run_obj, args, kwargs)
        finally:
            self._teardown(proc)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _write(self, proc: subprocess.Popen, msg: dict) -> None:
        """Send a JSON-line command to the worker's stdin."""
        data = (json.dumps(msg, ensure_ascii=False) + "\n").encode()
        try:
            proc.stdin.write(data)
            proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass  # worker already dead

    def _readline(self, proc: subprocess.Popen) -> Optional[dict]:
        """Read one JSON-line from the worker's stdout.  Returns None on EOF."""
        raw = proc.stdout.readline()
        if not raw:
            return None
        try:
            return json.loads(raw.decode(errors="replace"))
        except (json.JSONDecodeError, ValueError):
            return None  # stray print – skip

    def _drive(self, proc, run_obj, args, kwargs) -> Any:
        """Single-threaded driver: wait for ready, send run, relay messages."""

        # --- 1. Wait for "ready" ------------------------------------------
        while True:
            msg = self._readline(proc)
            if msg is None:
                raise RuntimeError(
                    "Worker exited before sending 'ready'. "
                    "Check stderr for details."
                )
            if msg.get("type") == "ready":
                break
            if msg.get("type") == "error":
                raise RuntimeError(msg.get("error", "worker init error"))

        # --- 2. Send the run command --------------------------------------
        self._write(proc, {
            "type": "run",
            "run_id": run_obj.id,
            "args": list(args),
            "kwargs": kwargs,
        })

        # --- 3. Start a stderr-drain thread (so it never fills up) --------
        stderr_lines: list[str] = []

        def _drain_stderr():
            for raw in proc.stderr:
                stderr_lines.append(raw.decode(errors="replace").rstrip())

        threading.Thread(target=_drain_stderr, daemon=True).start()

        # --- 4. Start a cancel-watcher thread -----------------------------
        cancel_sent = threading.Event()

        def _cancel_watcher():
            run_obj.cancel.wait()  # blocks until set
            if not cancel_sent.is_set():
                cancel_sent.set()
                self._write(proc, {"type": "cancel", "run_id": run_obj.id})

        threading.Thread(target=_cancel_watcher, daemon=True).start()

        # --- 5. Read messages until result / error / EOF ------------------
        output_path: Any = None
        error_msg: Optional[str] = None

        while True:
            msg = self._readline(proc)
            if msg is None:
                # EOF – worker died before sending result/error.
                if run_obj.cancel.is_set():
                    break
                error_msg = (
                    "Worker exited unexpectedly.\n"
                    + "\n".join(stderr_lines[-20:])
                )
                break

            mtype = msg.get("type")
            rid = msg.get("run_id")

            if mtype == "progress" and rid == run_obj.id:
                run_obj.progress = msg.get("value", 0)

            elif mtype == "log" and rid == run_obj.id:
                pass  # could forward to a log collector

            elif mtype == "result" and rid == run_obj.id:
                output_path = msg.get("output_path")
                break

            elif mtype == "error" and rid == run_obj.id:
                error_msg = msg.get("error", "unknown worker error")
                tb = msg.get("traceback", "")
                if tb:
                    error_msg += "\n" + tb
                break

        # --- 6. Translate outcome ----------------------------------------
        if error_msg:
            raise RuntimeError(error_msg)
        return output_path

    def _teardown(self, proc: subprocess.Popen) -> None:
        """Ensure the worker process is fully stopped."""
        self._write(proc, {"type": "shutdown"})
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        # Close pipes to avoid ResourceWarnings.
        for pipe in (proc.stdin, proc.stdout, proc.stderr):
            if pipe:
                try:
                    pipe.close()
                except Exception:
                    pass
