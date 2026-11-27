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
