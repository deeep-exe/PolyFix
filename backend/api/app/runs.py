import uuid
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

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
        self.runs: dict[str, Run] = {}  # all jobs, by ID
        self.pool = ThreadPoolExecutor(max_workers=1)  # one chef

    def submit(self, fn, *args) -> Run:
        run = Run(id=uuid.uuid4().hex)
        self.runs[run.id] = run
        self.pool.submit(self._execute, run, fn, *args)
        return run

    def _execute(self, run, fn, *args):
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