"""PolyFix adapter for the local OpenAI Shap-E Diffusers checkpoint."""

from pathlib import Path


_PIPE = None


def _get_pipeline():
    global _PIPE
    if _PIPE is None:
        import torch
        from diffusers import ShapEPipeline

        model_dir = Path(__file__).resolve().parent
        dtype = torch.float16 if torch.cuda.is_available() else torch.float32
        pipe = ShapEPipeline.from_pretrained(str(model_dir), torch_dtype=dtype)
        if torch.cuda.is_available():
            pipe.enable_model_cpu_offload()
        _PIPE = pipe
    return _PIPE


def generate_text(prompt, out_path, num_inference_steps=64, guidance_scale=15.0, frame_size=256):
    """Generate a mesh from a text prompt and save it as GLB."""
    from diffusers.utils import export_to_mesh
    import trimesh

    output_path = Path(out_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    mesh_data = _get_pipeline()(
        prompt,
        num_inference_steps=num_inference_steps,
        guidance_scale=guidance_scale,
        frame_size=frame_size,
        output_type="mesh",
    ).images[0]

    temporary_obj = output_path.with_suffix(".obj")
    export_to_mesh(mesh_data, str(temporary_obj))
    mesh = trimesh.load(str(temporary_obj), force="mesh")
    mesh.export(str(output_path))
    temporary_obj.unlink(missing_ok=True)
    return str(output_path)


def generate(run, image_path, out_dir):
    """PolyFix entry point; the current run request has no text-prompt field."""
    raise RuntimeError(
        "Shap-E is registered. This checkpoint generates from text prompts; "
        "the current PolyFix run request does not provide a prompt."
    )
