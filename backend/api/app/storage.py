"""Portable, repository-local storage locations for model assets and caches."""
import os
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
MODEL_DIR = Path(os.environ.get("POLYFIX_MODELS_DIR", REPO_ROOT / "models")).expanduser().resolve()
CATEGORIES = {
    "image-to-3d": MODEL_DIR / "image-to-3d",
    "text-to-3d": MODEL_DIR / "text-to-3d",
    "mesh-repair": MODEL_DIR / "mesh-repair",
    "preprocessors": MODEL_DIR / "preprocessors",
    "bin": MODEL_DIR / "bin",
    "cache": MODEL_DIR / ".cache",
}


def configure_model_environment() -> None:
    """Pin library caches to the resolved repository model root before ML imports."""
    for directory in CATEGORIES.values():
        directory.mkdir(parents=True, exist_ok=True)
    cache = CATEGORIES["cache"]
    # Pin every supported library cache to this repository, even if the shell
    # inherited a per-user cache override.
    os.environ["HF_HOME"] = str(cache / "huggingface")
    os.environ["HF_HUB_CACHE"] = str(cache / "huggingface" / "hub")
    os.environ["TORCH_HOME"] = str(cache / "torch")
    os.environ["REMBG_HOME"] = str(CATEGORIES["preprocessors"])
    os.environ["U2NET_HOME"] = str(CATEGORIES["preprocessors"])


def category_for(manifest: dict | None = None, source_url: str = "") -> str:
    manifest = manifest or {}
    requested = str(manifest.get("storage_category", "")).strip().lower()
    if requested in {"image-to-3d", "text-to-3d", "mesh-repair", "preprocessors", "bin"}:
        return requested
    text = " ".join((str(manifest.get("id", "")), str(manifest.get("name", "")), source_url)).lower()
    if any(word in text for word in ("mesh-repair", "retopolog", "remesh")):
        return "mesh-repair"
    if "rembg" in text or "u2net" in text:
        return "preprocessors"
    if any(word in text for word in ("instant-mesh", "instant meshes", "gltf-validator", "blender-cli")):
        return "bin"
    if any(word in text for word in ("text-to-3d", "text2-3d", "text-to-3", "shap-e-text")):
        return "text-to-3d"
    return "image-to-3d"


def model_path(model_id: str, category: str = "image-to-3d") -> Path:
    if category not in CATEGORIES or category == "cache":
        raise ValueError(f"Invalid model category: {category}")
    return CATEGORIES[category] / model_id


def iter_model_folders():
    for category in ("image-to-3d", "text-to-3d", "mesh-repair", "preprocessors", "bin"):
        root = CATEGORIES[category]
        if root.exists():
            yield from (path for path in root.iterdir() if path.is_dir() and not path.name.startswith(".tmp-"))


configure_model_environment()
