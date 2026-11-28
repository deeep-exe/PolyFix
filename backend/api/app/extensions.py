
import importlib.util
import json
import types
from pathlib import Path
from .storage import iter_model_folders

EXT_DIR = Path(__file__).resolve().parent.parent / "extensions"


def check_cuda_and_deps(entry_file: Path) -> tuple[bool, str]:
    """Return whether a GPU-backed extension can run in this Python environment."""
    if not entry_file.is_file():
        return False, "Extension entry file is missing."
    try:
        import torch
    except Exception as exc:
        return False, f"PyTorch is unavailable: {exc}"
    if not torch.cuda.is_available():
        return False, "CUDA is not available."
    return True, "CUDA is available."


def _make_stub_generate(module_path: Path):
    """Return a no-op function whose __module__ resolves to *module_path*.

    When the API venv cannot import a model's generator.py (because torch /
    transformers / etc. are not installed), we still need a callable with the
    right __module__ so RunManager.submit() can auto-detect model_dir and
    delegate to the subprocess worker.
    """
    # Create a tiny synthetic module registered in sys.modules.
    import sys
    mod_name = f"_polyfix_stub_{module_path.stem}_{id(module_path)}"
    stub_module = types.ModuleType(mod_name)
    stub_module.__file__ = str(module_path)
    sys.modules[mod_name] = stub_module

    def _stub_generate(run, *args, **kwargs):
        raise RuntimeError(
            f"Direct in-process call to {module_path.name} is not supported. "
            "This generator must run via the subprocess worker."
        )

    _stub_generate.__module__ = mod_name
    return _stub_generate


def load_all() -> dict:
    """Load built-in plugins and installed model-backed extensions.

    For each extension we try to import the generator module.  If the import
    fails (e.g. the API venv doesn't have torch), we create a lightweight
    stub so the subprocess worker can still locate and run it.
    """
    found = {}
    folders = list(EXT_DIR.iterdir()) if EXT_DIR.exists() else []
    folders.extend(iter_model_folders())
    for folder in folders:
        if not folder.is_dir():
            continue
        manifest_file = folder / "manifest.json"
        if not manifest_file.exists():
            continue

        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
        except Exception as e:
            print(f"Skipping {folder.name}: bad manifest: {e}")
            continue

        entry_name = manifest.get("entry", "generator.py")
        entry_path = folder / entry_name

        # Try a full in-process import first (works when deps are available).
        generate_fn = None
        try:
            spec = importlib.util.spec_from_file_location(
                manifest["id"], entry_path
            )
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            generate_fn = module.generate
        except Exception:
            # Import failed — create a stub that carries the right __file__
            # so the subprocess executor can find the model directory.
            if entry_path.is_file():
                generate_fn = _make_stub_generate(entry_path)
            else:
                print(f"Skipping {folder.name}: entry file missing ({entry_name})")
                continue

        found[manifest["id"]] = {
            "manifest": manifest,
            "generate": generate_fn,
        }

    return found
