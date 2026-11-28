import uuid
import time
import threading
import sys
from dataclasses import dataclass, field
from pathlib import Path
from .subprocess_executor import SubprocessExecutor


@dataclass
class Run:
    id: str
    status: str = "queued"
    progress: int = 0
    output_path: str | None = None
    error: str | None = None
    created: float = field(default_factory=time.time)
    cancel: threading.Event = field(default_factory=threading.Event)


class RunManager:
    def __init__(self):
        self.runs: dict[str, Run] = {}
        # Default to the shared backend venv; per-model envs will override this later.
        venv_python = Path(__file__).parents[2] / '.venv' / 'Scripts' / 'python.exe'
        self.executor = SubprocessExecutor(str(venv_python))

    def submit(self, fn, *args, model_dir: str | None = None, entry: str = "generator.py") -> Run:
        """Submit a run.

        If *model_dir* is provided the generator is executed in a subprocess
        worker using the JSON-line protocol.  Otherwise the function *fn* is
        called directly in a background thread (legacy path).
        """
        run = Run(id=uuid.uuid4().hex)
        self.runs[run.id] = run

        # Try to auto-detect model_dir from the function's module when not
        # provided explicitly.
        if model_dir is None and hasattr(fn, "__module__"):
            mod = sys.modules.get(fn.__module__)
            if mod and hasattr(mod, "__file__") and mod.__file__:
                mod_path = Path(mod.__file__)
                model_dir = str(mod_path.parent)
                entry = mod_path.name

        if model_dir:
            threading.Thread(
                target=self._execute_subprocess,
                args=(run, model_dir, entry, args),
                daemon=True,
            ).start()
        else:
            threading.Thread(
                target=self._execute_legacy,
                args=(run, fn, args),
                daemon=True,
            ).start()
        return run

    # ---- subprocess path (new) -----------------------------------------
    def _execute_subprocess(self, run: Run, model_dir: str, entry: str, args: tuple):
        if run.cancel.is_set():
            run.status = "cancelled"
            return
        run.status = "running"
        try:
            run.output_path = self.executor.run(run, model_dir, entry, *args)
            run.status = "done"
            run.progress = 100
        except Exception as e:
            if run.cancel.is_set():
                run.status = "cancelled"
            else:
                run.status = "failed"
                run.error = str(e)

    # ---- direct-call path (legacy fallback) ----------------------------
    def _execute_legacy(self, run: Run, fn, args: tuple):
        if run.cancel.is_set():
            run.status = "cancelled"
            return
        run.status = "running"
        try:
            run.output_path = fn(run, *args)
            run.status = "done"
            run.progress = 100
        except Exception as e:
            if run.cancel.is_set():
                run.status = "cancelled"
            else:
                run.status = "failed"
                run.error = str(e)
