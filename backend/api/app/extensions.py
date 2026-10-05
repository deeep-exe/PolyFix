
import json
import importlib.util
from pathlib import Path

EXT_DIR = Path(__file__).resolve().parent.parent / "extensions"

def load_all() -> dict:
    """Scan the extensions folder and load every valid extension."""
    found = {}
    if not EXT_DIR.exists():
        return found

    for folder in EXT_DIR.iterdir():
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
