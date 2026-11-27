
import importlib.util
import json
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


def load_all() -> dict:
    """Load built-in plugins and installed model-backed extensions."""
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
            manifest = json.loads(manifest_file.read_text())
            spec = importlib.util.spec_from_file_location(
                manifest["id"], folder / manifest["entry"]
            )
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

            found[manifest["id"]] = {
                "manifest": manifest,
                "generate": module.generate,
            }
        except Exception as e:
            print(f"Skipping {folder.name}: {e}")  # one bad plugin shouldn't crash the whole loader

    return found
