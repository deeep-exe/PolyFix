import importlib.util
import json
import re
from pathlib import Path

from ..extensions import EXT_DIR, check_cuda_and_deps
from ..storage import iter_model_folders


MODULE_NAMES = {
    "huggingface-hub": "huggingface_hub",
    "pyyaml": "yaml",
    "scikit-image": "skimage",
    "opencv-python": "cv2",
    "pillow": "PIL",
    "beautifulsoup4": "bs4",
}


def _resolve_extension(extension_id: str) -> Path | None:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", extension_id):
        return None
    direct = EXT_DIR / extension_id
    if direct.is_dir():
        return direct
    folders = list(EXT_DIR.iterdir()) if EXT_DIR.exists() else []
    folders.extend(iter_model_folders())
    for folder in folders:
        manifest_file = folder / "manifest.json"
        if not folder.is_dir() or not manifest_file.exists():
            continue
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        if manifest.get("id") == extension_id:
            return folder
    return None


def _parse_requirements(requirements_file: Path) -> list[str]:
    if not requirements_file.exists():
        return []
    requirements = []
    for raw_line in requirements_file.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        package = re.split(r"[<>=!~; \[]", line, maxsplit=1)[0].strip()
        if package:
            requirements.append(package)
    return requirements


def _module_name(package: str) -> str:
    normalized = package.lower().replace("_", "-")
    return MODULE_NAMES.get(normalized, normalized.replace("-", "_"))


def _cuda_available() -> bool:
    try:
        torch = __import__("torch")
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def audit_extension(extension_id: str) -> dict:
    folder = _resolve_extension(extension_id)
    if folder is None:
        return {
            "extension_id": extension_id,
            "missing_packages": [],
            "cuda_available": False,
            "is_ready": False,
            "error": "Extension not found.",
        }

    requirements = _parse_requirements(folder / "requirements.txt")
    if extension_id == "shap-e":
        for required_package in ("diffusers", "transformers"):
            if required_package not in requirements:
                requirements.append(required_package)
    missing_packages = [
        package
        for package in requirements
        if importlib.util.find_spec(_module_name(package)) is None
    ]
    cuda_available = _cuda_available()

    manifest_file = folder / "manifest.json"
    requires_gpu = False
    entry_name = "generator.py"
    if manifest_file.exists():
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
            requires_gpu = bool(manifest.get("requires_gpu", False))
            entry_name = manifest.get("entry", "generator.py")
        except Exception:
            pass

    entry_file = folder / entry_name
    if requires_gpu:
        checked_ready, _ = check_cuda_and_deps(entry_file)
    else:
        checked_ready = True

    return {
        "extension_id": extension_id,
        "missing_packages": missing_packages,
        "cuda_available": cuda_available,
        "is_ready": checked_ready and not missing_packages,
    }


def audit_extension_deps(extension_id: str) -> dict:
    return audit_extension(extension_id)
