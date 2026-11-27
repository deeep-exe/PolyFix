"""Automatic generator injection and missing-generator notification for imported models."""
import json
from pathlib import Path


SHAP_E_GENERATOR_CODE = '''from pathlib import Path
import torch
from PIL import Image
from diffusers import ShapEImg2ImgPipeline
from diffusers.utils import export_to_mesh
import trimesh


_PIPE = None


def _get_pipeline(model_dir: str):
    global _PIPE
    if _PIPE is None:
        dtype = torch.float16 if torch.cuda.is_available() else torch.float32
        pipe = ShapEImg2ImgPipeline.from_pretrained(model_dir, torch_dtype=dtype)
        if torch.cuda.is_available():
            # Keep peak VRAM under ~3 GB for 4 GB GPUs (e.g., RTX 3050 Laptop).
            pipe.enable_model_cpu_offload()
        _PIPE = pipe
    return _PIPE


def generate(run, image_path, out_dir):
    if run.cancel.is_set():
        raise RuntimeError("cancelled")

    run.progress = 10
    model_dir = str(Path(__file__).resolve().parent)
    pipe = _get_pipeline(model_dir)

    if run.cancel.is_set():
        raise RuntimeError("cancelled")

    run.progress = 30
    image = Image.open(image_path).convert("RGB")
    images = pipe(
        image,
        guidance_scale=3.0,
        num_inference_steps=64,
        frame_size=256,
        output_type="mesh",
    ).images

    if run.cancel.is_set():
        raise RuntimeError("cancelled")

    run.progress = 85
    out_path = Path(out_dir) / f"{run.id}.glb"
    mesh_data = images[0]
    tmp_obj = Path(out_dir) / f"{run.id}_tmp.obj"
    export_to_mesh(mesh_data, str(tmp_obj))
    mesh = trimesh.load(str(tmp_obj), force="mesh")
    mesh.export(str(out_path))
    tmp_obj.unlink(missing_ok=True)
    run.progress = 100
    return str(out_path)
'''

STUB_GENERATOR_CODE = '''def generate(run, image_path, out_dir):
    raise RuntimeError("This extension has no compatible generator implementation yet.")
'''

HUNYUAN3D_GENERATOR_CODE = '''from pathlib import Path
import torch
from PIL import Image


_PIPE = None
_PIPE_SUBFOLDER = None

_DIT_SUBFOLDERS = (
    "hunyuan3d-dit-v2-mini-turbo",
    "hunyuan3d-dit-v2-mini-fast",
    "hunyuan3d-dit-v2-mini",
    "hunyuan3d-dit-v2-0",
)


def _find_local_dit_subfolder(model_dir: Path) -> str:
    for subfolder in _DIT_SUBFOLDERS:
        candidate = model_dir / subfolder
        if not candidate.is_dir():
            continue
        has_weights = any(candidate.glob("*.safetensors")) or any(candidate.glob("*.ckpt"))
        if has_weights:
            return subfolder
    raise RuntimeError(
        f"Missing Hunyuan3D DiT shape-generator weights in {model_dir}. "
        "Download one of the DiT subfolders (e.g. hunyuan3d-dit-v2-mini/model.fp16.safetensors) "
        "from tencent/Hunyuan3D-2mini into this folder."
    )


def _get_pipeline(model_dir: Path):
    global _PIPE, _PIPE_SUBFOLDER
    try:
        from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
    except ImportError as exc:
        raise RuntimeError(
            "Hunyuan3D-2 runtime (hy3dgen) is not installed in backend/api/.venv. "
            "Install it with: pip install git+https://github.com/Tencent/Hunyuan3D-2.git"
        ) from exc

    subfolder = _find_local_dit_subfolder(model_dir)
    if _PIPE is None or _PIPE_SUBFOLDER != subfolder:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        use_safetensors = any((model_dir / subfolder).glob("*.safetensors"))
        _PIPE = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
            str(model_dir),
            subfolder=subfolder,
            use_safetensors=use_safetensors,
            device=device,
        )
        _PIPE_SUBFOLDER = subfolder
    return _PIPE


def generate(run, image_path, out_dir):
    if run.cancel.is_set():
        raise RuntimeError("cancelled")

    run.progress = 10
    model_dir = Path(__file__).resolve().parent
    pipe = _get_pipeline(model_dir)

    if run.cancel.is_set():
        raise RuntimeError("cancelled")

    run.progress = 30
    image = Image.open(image_path).convert("RGBA")
    result = pipe(
        image=image,
        num_inference_steps=30,
        octree_resolution=256,
        num_chunks=20000,
        generator=torch.manual_seed(12345),
        output_type="trimesh",
    )
    mesh = result[0] if isinstance(result, (list, tuple)) else result

    if run.cancel.is_set():
        raise RuntimeError("cancelled")

    run.progress = 85
    out_path = Path(out_dir) / f"{run.id}.glb"
    mesh.export(str(out_path))
    run.progress = 100
    return str(out_path)
'''


def _is_shap_e_repo(folder: Path, manifest: dict, source_url: str) -> bool:
    ident = " ".join((
        str(manifest.get("id", "")),
        str(manifest.get("name", "")),
        source_url,
    )).lower()
    if "shap-e" in ident or "openai/shap-e" in ident:
        return True

    model_index = folder / "model_index.json"
    if model_index.exists():
        try:
            data = json.loads(model_index.read_text(encoding="utf-8-sig"))
            cls_name = str(data.get("_class_name", "")).lower()
            if "shape" in cls_name:
                return True
        except Exception:
            pass
    return False


def _is_hunyuan3d_repo(folder: Path, manifest: dict, source_url: str) -> bool:
    ident = " ".join((
        str(manifest.get("id", "")),
        str(manifest.get("name", "")),
        source_url,
    )).lower()
    if "hunyuan3d" in ident:
        return True
    return any((folder / name).is_dir() for name in ("hunyuan3d-dit-v2-mini", "hunyuan3d-dit-v2-mini-turbo", "hunyuan3d-dit-v2-0"))


def ensure_generator(folder: Path, manifest: dict, source_url: str) -> dict:
    """Ensure an imported repo has generator.py; inject a known adapter or stub and report status."""
    entry_name = manifest.get("entry") or "generator.py"
    entry_file = folder / entry_name
    if entry_file.exists():
        return {
            "had_generator": True,
            "injected": False,
            "kind": "existing",
            "notice": None,
        }

    if _is_shap_e_repo(folder, manifest, source_url):
        entry_file.write_text(SHAP_E_GENERATOR_CODE, encoding="utf-8")
        req_file = folder / "requirements.txt"
        if not req_file.exists():
            req_file.write_text(
                "diffusers\ntransformers\naccelerate\ntrimesh\npillow\n",
                encoding="utf-8",
            )
        manifest["requires_gpu"] = True
        notice = (
            "No generator.py was found in this model repo. "
            "PolyFix installed its Shap-E (4GB VRAM FP16 + CPU offload) generator."
        )
        manifest["generator_notice"] = notice
        return {
            "had_generator": False,
            "injected": True,
            "kind": "shap-e",
            "notice": notice,
        }

    if _is_hunyuan3d_repo(folder, manifest, source_url):
        entry_file.write_text(HUNYUAN3D_GENERATOR_CODE, encoding="utf-8")
        req_file = folder / "requirements.txt"
        if not req_file.exists():
            req_file.write_text(
                "hy3dgen @ git+https://github.com/Tencent/Hunyuan3D-2.git\n"
                "trimesh\npillow\neinops\nomegaconf\nhuggingface-hub\n",
                encoding="utf-8",
            )
        manifest["requires_gpu"] = True
        notice = (
            "No generator.py was found in this model repo. "
            "PolyFix installed its Hunyuan3D-2 adapter."
        )
        manifest["generator_notice"] = notice
        return {
            "had_generator": False,
            "injected": True,
            "kind": "hunyuan3d",
            "notice": notice,
        }

    entry_file.write_text(STUB_GENERATOR_CODE, encoding="utf-8")
    notice = (
        "No generator.py was found in this model repo. "
        "PolyFix created a placeholder stub; a custom generator.py is required to run it."
    )
    manifest["generator_notice"] = notice
    return {
        "had_generator": False,
        "injected": False,
        "kind": "stub",
        "notice": notice,
    }
