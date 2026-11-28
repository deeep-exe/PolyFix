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


_COMPAT_PATCHED = False


def _remap_dinov2_state_dict(state_dict: dict) -> dict:
    """Remap transformers 4.x Dinov2Model keys to transformers 5.x naming."""
    remapped = {}
    for key, value in state_dict.items():
        if ".attention.attention.query." in key:
            remapped[key.replace(".attention.attention.query.", ".attention.q_proj.")] = value
        elif ".attention.attention.key." in key:
            remapped[key.replace(".attention.attention.key.", ".attention.k_proj.")] = value
        elif ".attention.attention.value." in key:
            remapped[key.replace(".attention.attention.value.", ".attention.v_proj.")] = value
        elif ".attention.output.dense." in key:
            remapped[key.replace(".attention.output.dense.", ".attention.o_proj.")] = value
        elif ".mlp.weights_in." in key:
            gate_val, up_val = value.chunk(2, dim=0)
            remapped[key.replace(".mlp.weights_in.", ".mlp.gate_proj.")] = gate_val
            remapped[key.replace(".mlp.weights_in.", ".mlp.up_proj.")] = up_val
        elif ".mlp.weights_out." in key:
            remapped[key.replace(".mlp.weights_out.", ".mlp.down_proj.")] = value
        else:
            remapped[key] = value
    return remapped


def _install_dinov2_compat_patch():
    global _COMPAT_PATCHED
    if _COMPAT_PATCHED:
        return

    from hy3dgen.shapegen.models.conditioner import DualImageEncoder, SingleImageEncoder

    for cls in (SingleImageEncoder, DualImageEncoder):
        orig_load_state_dict = cls.load_state_dict

        def _patched_load_state_dict(self, state_dict, strict=True, assign=False, _orig=orig_load_state_dict):
            encoder = getattr(self, "main_image_encoder", None)
            model = getattr(encoder, "model", None)
            layers = getattr(getattr(model, "encoder", None), "layer", None)
            if layers and hasattr(layers[0].attention, "q_proj"):
                if any(".attention.attention." in k or ".mlp.weights_in." in k for k in state_dict):
                    state_dict = _remap_dinov2_state_dict(state_dict)
            return _orig(self, state_dict, strict=strict, assign=assign)

        cls.load_state_dict = _patched_load_state_dict

    _COMPAT_PATCHED = True


def _get_pipeline(model_dir: Path):
    global _PIPE, _PIPE_SUBFOLDER
    try:
        from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
    except ImportError as exc:
        raise RuntimeError(
            "Hunyuan3D-2 runtime (hy3dgen) is not installed in backend/api/.venv. "
            "Install it with: pip install git+https://github.com/Tencent/Hunyuan3D-2.git"
        ) from exc

    _install_dinov2_compat_patch()

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
