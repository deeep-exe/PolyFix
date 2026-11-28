"""
Smoke test for model import, analysis and optimisation (app/assets.py).

Run from backend/api:  .venv\\Scripts\\python.exe tests\\test_assets.py
"""
import sys
import tempfile
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.assets import AssetStore, OptimizeRequest  # noqa: E402


def textured_sphere() -> trimesh.Trimesh:
    sphere = trimesh.creation.uv_sphere(count=[64, 64])
    normalized = sphere.vertices / np.linalg.norm(sphere.vertices, axis=1, keepdims=True)
    uv = np.column_stack([
        0.5 + np.arctan2(normalized[:, 0], normalized[:, 2]) / (2 * np.pi),
        0.5 + np.arcsin(np.clip(normalized[:, 1], -1, 1)) / np.pi,
    ])
    texture = Image.new("RGB", (64, 64), (200, 80, 30))
    sphere.visual = trimesh.visual.TextureVisuals(uv=uv, image=texture)
    return sphere


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name} {detail}")
    if not ok:
        raise SystemExit(1)


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        store = AssetStore(tmp / "assets")

        # Textured GLB
        glb = tmp / "sphere.glb"
        textured_sphere().export(str(glb))
        asset = store.create("sphere.glb", glb)
        faces = asset["original"]["stats"]["faces"]
        check("import glb", faces > 5000, f"({faces} faces)")
        check("uv detected", asset["original"]["stats"]["has_uv"])
        check("albedo detected", asset["original"]["stats"]["texture_maps"]["albedo"])

        optimized = store.optimize(asset["id"], OptimizeRequest(target_ratio=0.25))
        new_faces = optimized["optimized"]["stats"]["faces"]
        check("decimated", new_faces <= faces * 0.3, f"({faces} -> {new_faces})")
        check("uv kept", optimized["optimized"]["stats"]["has_uv"])
        fidelity = optimized["optimized"]["stats"]["hausdorff"]
        check("fidelity measured", fidelity is not None and fidelity < 0.05, f"({fidelity:.4f})")
        check("optimized file", store.file(asset["id"], "optimized").exists())
        before = np.array(asset["original"]["stats"]["extents"])
        after = np.array(optimized["optimized"]["stats"]["extents"])
        # Regression: decimating seam-split (textured) meshes once flung vertices far outside the model.
        check("size preserved", np.allclose(before, after, rtol=0.05), f"({before.round(2)} -> {after.round(2)})")

        # Plain STL and OBJ
        for suffix in (".stl", ".obj"):
            path = tmp / f"box{suffix}"
            trimesh.creation.icosphere(subdivisions=4).export(str(path))
            asset = store.create(path.name, path)
            check(f"import {suffix}", asset["original"]["stats"]["watertight"])

        # Broken file
        bad = tmp / "bad.glb"
        bad.write_bytes(b"not a model")
        try:
            store.create("bad.glb", bad)
        except Exception as exc:
            check("rejects broken file", True, f"({type(exc).__name__})")
        else:
            check("rejects broken file", False)
        check("broken file cleaned up", len(list((tmp / "assets").iterdir())) == 3)

        # The newest real generator output, if any
        outputs = sorted((Path(__file__).resolve().parents[1] / "outputs").glob("*.glb"),
                         key=lambda p: p.stat().st_mtime)
        if outputs:
            sample = outputs[-1]
            asset = store.create(sample.name, sample)
            print(f"      {sample.name}:", {c["id"]: c["value"] for c in asset["original"]["checks"]})
            optimized = store.optimize(asset["id"], OptimizeRequest(target_ratio=0.5))
            print("      optimized:   ", {c["id"]: c["value"] for c in optimized["optimized"]["checks"]})

    print("all asset checks passed")


if __name__ == "__main__":
    main()
