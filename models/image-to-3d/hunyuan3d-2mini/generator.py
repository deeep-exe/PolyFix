from pathlib import Path
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
