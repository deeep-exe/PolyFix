#!/usr/bin/env python
"""Worker host for per-model execution.

Launched by SubprocessExecutor with the model env's Python interpreter:
  <env>/Scripts/python.exe  worker_host.py --model-dir <dir> --entry generator.py

Protocol (line-delimited JSON on stdout):
  worker -> server:
    {"type": "ready"}
    {"type": "progress", "run_id": "...", "value": int}
    {"type": "log",      "run_id": "...", "line": "..."}
    {"type": "result",   "run_id": "...", "output_path": "..."}
    {"type": "error",    "run_id": "...", "error": "...", "traceback": "..."}

  server -> worker (stdin):
    {"type": "run",      "run_id": "...", "args": [...], "kwargs": {...}}
    {"type": "cancel",   "run_id": "..."}
    {"type": "shutdown"}

Stdout isolation:
  Before importing any model code we duplicate the real stdout to a private
  file descriptor and redirect sys.stdout to stderr.  This way stray print()
  calls from libraries end up on stderr (which the server drains) and cannot
  corrupt the JSON protocol stream.
"""
import argparse
import importlib.util
import io
import json
import os
import sys
import threading
import traceback
from pathlib import Path
from typing import Any, Dict, List


# ---------------------------------------------------------------------------
# 1. Stdout isolation – must happen before ANY library imports.
# ---------------------------------------------------------------------------
_protocol_fd = os.dup(sys.stdout.fileno())          # private copy of real stdout
_protocol_stream = os.fdopen(_protocol_fd, "w", 1)  # line-buffered text wrapper
sys.stdout = sys.stderr   # all future print() goes to stderr


# ---------------------------------------------------------------------------
# 2. Protocol helpers
# ---------------------------------------------------------------------------
_send_lock = threading.Lock()


def _send(msg: Dict[str, Any]) -> None:
    """Write one JSON line to the protocol channel (thread-safe)."""
    line = json.dumps(msg, ensure_ascii=False) + "\n"
    with _send_lock:
        _protocol_stream.write(line)
        _protocol_stream.flush()


# ---------------------------------------------------------------------------
# 3. RunProxy – the "run" object handed to generate()
# ---------------------------------------------------------------------------
class RunProxy:
    """Drop-in replacement for the Run dataclass, used inside the worker.

    Attribute writes to `progress` are forwarded as protocol messages.
    `cancel` is a real threading.Event, set from a reader thread when the
    server sends a cancel command.
    """

    def __init__(self, run_id: str):
        self.run_id = run_id
        self.id = run_id  # generators use run.id for output filenames
        self._progress = 0
        self.cancel = threading.Event()
        self._extra: Dict[str, Any] = {}

    def __getattr__(self, name: str) -> Any:
        try:
            return self._extra[name]
        except KeyError:
            raise AttributeError(name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name in {"run_id", "id", "_progress", "cancel", "_extra"}:
            object.__setattr__(self, name, value)
            return
        if name == "progress":
            self._progress = int(value)
            _send({"type": "progress", "run_id": self.run_id, "value": self._progress})
            return
        if name == "status":
            # generator.py might write run.status = ...; just store it.
            self._extra["status"] = value
            return
        self._extra[name] = value

    @property
    def progress(self):
        return self._progress

    @progress.setter
    def progress(self, value):
        self._progress = int(value)
        _send({"type": "progress", "run_id": self.run_id, "value": self._progress})


# ---------------------------------------------------------------------------
# 4. Module loader
# ---------------------------------------------------------------------------
def _load_generator(module_path: Path):
    spec = importlib.util.spec_from_file_location("generator", str(module_path))
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load module from {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# 5. Main loop
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="PolyFix model worker host")
    parser.add_argument("--model-dir", required=True, help="Path to model folder")
    parser.add_argument("--entry", default="generator.py", help="Entry script inside model folder")
    args = parser.parse_args()

    model_dir = Path(args.model_dir).resolve()
    entry_path = (model_dir / args.entry).resolve()

    # Add model dir to sys.path so relative imports inside generator.py work.
    if str(model_dir) not in sys.path:
        sys.path.insert(0, str(model_dir))

    # Load the generator module.
    try:
        module = _load_generator(entry_path)
    except Exception as exc:
        _send({"type": "error", "run_id": None,
               "error": str(exc), "traceback": traceback.format_exc()})
        sys.exit(1)

    # Optional hook: if the module defines load(), call it once.
    if hasattr(module, "load") and callable(module.load):
        try:
            module.load()
        except Exception as exc:
            _send({"type": "error", "run_id": None,
                   "error": f"load() failed: {exc}",
                   "traceback": traceback.format_exc()})
            sys.exit(1)

    # Signal readiness.
    _send({"type": "ready"})

    active_runs: Dict[str, RunProxy] = {}

    # Read stdin commands (blocking).
    while True:
        raw = sys.stdin.readline()
        if not raw:
            break  # EOF
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue

        mtype = msg.get("type")

        if mtype == "run":
            run_id = msg["run_id"]
            args_list: List[Any] = msg.get("args", [])
            kwargs: Dict[str, Any] = msg.get("kwargs", {})
            proxy = RunProxy(run_id)
            active_runs[run_id] = proxy

            # Capture run_id/args in the closure correctly.
            def _make_runner(_proxy, _args, _kwargs, _rid):
                def _run():
                    try:
                        result = module.generate(_proxy, *_args, **_kwargs)
                        _send({"type": "result", "run_id": _rid,
                               "output_path": result})
                    except Exception as exc:
                        _send({"type": "error", "run_id": _rid,
                               "error": str(exc),
                               "traceback": traceback.format_exc()})
                    finally:
                        active_runs.pop(_rid, None)
                return _run

            threading.Thread(
                target=_make_runner(proxy, args_list, kwargs, run_id),
                daemon=True,
            ).start()

        elif mtype == "cancel":
            run_id = msg.get("run_id")
            proxy = active_runs.get(run_id)
            if proxy:
                proxy.cancel.set()

        elif mtype == "shutdown":
            break

    sys.exit(0)


if __name__ == "__main__":
    main()
