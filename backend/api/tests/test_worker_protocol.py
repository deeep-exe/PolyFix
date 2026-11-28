"""
Smoke test for the worker_host / SubprocessExecutor protocol.

Creates a tiny dummy generator module, launches worker_host.py via
SubprocessExecutor, and verifies that the full protocol round-trip works:
  ready -> run -> progress -> result
"""
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# 1. Create a temporary model folder with a minimal generator.py
# ---------------------------------------------------------------------------
_GENERATOR_SRC = '''
import time

def generate(run, image_path, out_dir):
    """Dummy generator that sends progress and returns a fake output path."""
    for i in range(0, 101, 20):
        if run.cancel.is_set():
            raise RuntimeError("cancelled by user")
        run.progress = i
        time.sleep(0.05)
    return out_dir + "/output.glb"
'''

def test_protocol_roundtrip():
    with tempfile.TemporaryDirectory(prefix="pf_test_") as tmpdir:
        model_dir = Path(tmpdir)
        (model_dir / "generator.py").write_text(_GENERATOR_SRC)

        # Determine the Python interpreter to use (the one running this test).
        python_exe = sys.executable

        # Import the executor.
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from app.subprocess_executor import SubprocessExecutor

        executor = SubprocessExecutor(python_exe)

        # Simulate a Run object.
        class FakeRun:
            def __init__(self):
                self.id = "test-run-001"
                self.status = "queued"
                self.progress = 0
                self.output_path = None
                self.error = None
                self.cancel = threading.Event()

        run = FakeRun()
        result = executor.run(run, str(model_dir), "generator.py",
                              "/tmp/input.png", "/tmp/output")

        assert result is not None, "Expected a result path"
        assert result == "/tmp/output/output.glb", f"Unexpected result: {result}"
        assert run.progress == 100, f"Expected progress=100, got {run.progress}"
        print(f"[PASS] Protocol roundtrip OK — result={result}, progress={run.progress}")


def test_cancel():
    with tempfile.TemporaryDirectory(prefix="pf_test_") as tmpdir:
        model_dir = Path(tmpdir)
        # Generator that takes a long time (will be cancelled).
        (model_dir / "generator.py").write_text('''
import time

def generate(run, *args, **kwargs):
    for i in range(100):
        if run.cancel.is_set():
            raise RuntimeError("cancelled by user")
        run.progress = i
        time.sleep(0.1)
    return "should_not_reach"
''')

        python_exe = sys.executable
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from app.subprocess_executor import SubprocessExecutor

        executor = SubprocessExecutor(python_exe)

        class FakeRun:
            def __init__(self):
                self.id = "test-cancel-001"
                self.status = "queued"
                self.progress = 0
                self.output_path = None
                self.error = None
                self.cancel = threading.Event()

        run = FakeRun()

        # Cancel after 0.3 seconds.
        def _cancel_later():
            time.sleep(0.3)
            run.cancel.set()
        threading.Thread(target=_cancel_later, daemon=True).start()

        error_raised = False
        try:
            executor.run(run, str(model_dir), entry="generator.py")
        except RuntimeError as e:
            error_raised = True
            assert "cancelled" in str(e).lower(), f"Unexpected error: {e}"

        assert error_raised, "Expected RuntimeError from cancellation"
        print(f"[PASS] Cancel test OK — progress reached {run.progress} before cancel")


if __name__ == "__main__":
    print("=" * 60)
    print("Test 1: Protocol round-trip")
    print("=" * 60)
    test_protocol_roundtrip()
    print()
    print("=" * 60)
    print("Test 2: Cancellation")
    print("=" * 60)
    test_cancel()
    print()
    print("All tests passed!")
