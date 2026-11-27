import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from ..extensions import EXT_DIR, check_cuda_and_deps
from ..storage import CATEGORIES, iter_model_folders


MODULE_NAMES = {
    "huggingface-hub": "huggingface_hub",
    "pyyaml": "yaml",
    "scikit-image": "skimage",
    "opencv-python": "cv2",
    "pillow": "PIL",
    "beautifulsoup4": "bs4",
}

KNOWN_INSTALL_SPECS = {
    "hy3dgen": "git+https://github.com/Tencent/Hunyuan3D-2.git",
}

_HUNYUAN_DIT_SUBFOLDERS = (
    "hunyuan3d-dit-v2-mini-turbo",
    "hunyuan3d-dit-v2-mini-fast",
    "hunyuan3d-dit-v2-mini",
    "hunyuan3d-dit-v2-0",
)


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


def _parse_requirement_specs(requirements_file: Path) -> list[tuple[str, str]]:
    """Return [(package_name, pip_install_spec), ...] from requirements.txt."""
    if not requirements_file.exists():
        return []
    specs: list[tuple[str, str]] = []
    for raw_line in requirements_file.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        # Handle PEP 508 direct URL syntax: `pkg @ git+https://...`
        if " @ " in line:
            pkg_part, url_part = line.split(" @ ", 1)
            package = re.split(r"[<>=!~; \[]", pkg_part.strip(), maxsplit=1)[0].strip()
            if package:
                specs.append((package, url_part.strip()))
            continue
        # Handle `#egg=pkg` URLs
        if line.startswith(("git+", "http://", "https://")):
            egg_match = re.search(r"#egg=([A-Za-z0-9_.-]+)", line)
            package = egg_match.group(1) if egg_match else Path(line.rstrip("/")).stem
            specs.append((package, line))
            continue
        package = re.split(r"[<>=!~; \[]", line, maxsplit=1)[0].strip()
        if package:
            specs.append((package, line))
    return specs


def _parse_requirements(requirements_file: Path) -> list[str]:
    return [pkg for pkg, _spec in _parse_requirement_specs(requirements_file)]


def _module_name(package: str) -> str:
    normalized = package.lower().replace("_", "-")
    return MODULE_NAMES.get(normalized, normalized.replace("-", "_"))


def _cuda_available() -> bool:
    try:
        torch = __import__("torch")
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _has_missing_weights(folder: Path, manifest: dict) -> str | None:
    """Return a short description if a model folder is missing required weights."""
    is_hunyuan = "hunyuan3d" in str(manifest.get("id", "")).lower() or any(
        (folder / sub).is_dir() for sub in _HUNYUAN_DIT_SUBFOLDERS
    )
    if is_hunyuan:
        has_dit = any(
            (folder / sub).is_dir()
            and (any((folder / sub).glob("*.safetensors")) or any((folder / sub).glob("*.ckpt")))
            for sub in _HUNYUAN_DIT_SUBFOLDERS
        )
        if not has_dit:
            return "Missing Hunyuan3D DiT shape-generator weights (hunyuan3d-dit-v2-mini*)."
    return None


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

    manifest: dict = {}
    manifest_file = folder / "manifest.json"
    if manifest_file.exists():
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
        except Exception:
            manifest = {}

    req_specs = _parse_requirement_specs(folder / "requirements.txt")
    requirements = [pkg for pkg, _ in req_specs]
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

    requires_gpu = bool(manifest.get("requires_gpu", False))
    entry_name = manifest.get("entry", "generator.py")
    entry_file = folder / entry_name
    if requires_gpu:
        checked_ready, _ = check_cuda_and_deps(entry_file)
    else:
        checked_ready = True

    weight_error = _has_missing_weights(folder, manifest)

    return {
        "extension_id": extension_id,
        "missing_packages": missing_packages,
        "cuda_available": cuda_available,
        "is_ready": checked_ready and not missing_packages and weight_error is None,
        **({"error": weight_error} if weight_error else {}),
    }


def install_missing_for_extension(extension_id: str, requested_packages: list[str] | None = None) -> dict:
    """One-click install missing Python dependencies and missing HF weights for any model."""
    folder = _resolve_extension(extension_id)
    if folder is None:
        audit = audit_extension(extension_id)
        audit["install_status"] = "failed"
        audit["install_error"] = "Model not found."
        return audit

    manifest: dict = {}
    manifest_file = folder / "manifest.json"
    if manifest_file.exists():
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
        except Exception:
            manifest = {}

    audit = audit_extension(extension_id)
    req_specs = dict(_parse_requirement_specs(folder / "requirements.txt"))
    packages = requested_packages if requested_packages else audit.get("missing_packages", [])

    if packages:
        pip_targets = [
            req_specs.get(pkg) or KNOWN_INSTALL_SPECS.get(pkg.lower(), pkg)
            for pkg in packages
        ]
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", *pip_targets],
            capture_output=True,
            text=True,
            timeout=900,
        )
        if result.returncode != 0:
            updated = audit_extension(extension_id)
            updated["install_status"] = "failed"
            updated["install_error"] = (
                result.stderr.strip() or result.stdout.strip() or "pip install failed."
            )
            return updated

    # Download missing weights if this model has a Hugging Face source_url.
    weight_error = _has_missing_weights(folder, manifest)
    source_url = str(manifest.get("source_url", "")).strip()
    if weight_error and "huggingface.co/" in source_url:
        repo_id = source_url.split("huggingface.co/", 1)[1].strip("/")
        try:
            from huggingface_hub import snapshot_download

            token = os.getenv("HF_TOKEN")
            allow_patterns = None
            if "hunyuan3d" in extension_id.lower():
                allow_patterns = [
                    "hunyuan3d-dit-v2-mini-turbo/*",
                    "hunyuan3d-vae-v2-mini-turbo/*",
                ]
            snapshot_download(
                repo_id=repo_id,
                local_dir=str(folder),
                cache_dir=str(CATEGORIES["cache"] / "huggingface" / "hub"),
                token=token,
                allow_patterns=allow_patterns,
            )
        except Exception as exc:
            updated = audit_extension(extension_id)
            updated["install_status"] = "failed"
            updated["install_error"] = f"Weight download failed: {exc}"
            return updated

    updated = audit_extension(extension_id)
    updated["install_status"] = "completed" if updated.get("is_ready") else "failed"
    if not updated.get("is_ready") and updated.get("error"):
        updated["install_error"] = updated["error"]
    return updated


def audit_extension_deps(extension_id: str) -> dict:
    return audit_extension(extension_id)
