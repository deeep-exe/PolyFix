"""Import, analyse and optimise existing 3D model files.

Every imported asset lives in ``outputs/assets/<id>/``:
  source.<ext>     the uploaded file, untouched
  original.glb     the upload converted to GLB (what the viewer loads)
  optimized.glb    written by ``optimize``
  meta.json        name, reports and the last optimisation settings
"""
from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path

import numpy as np
import trimesh
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageDraw
from pydantic import BaseModel, Field
from scipy.spatial import cKDTree

SUPPORTED_SUFFIXES = {".glb", ".gltf", ".obj", ".stl", ".ply", ".off"}
MAX_UPLOAD_BYTES = 512 * 1024 * 1024
# The UI's "< 5,000 quads" budget, expressed in triangles.
TRIANGLE_BUDGET = 10_000
FIDELITY_TOLERANCE = 0.01  # Hausdorff distance as a fraction of the bounding-box diagonal
VARIANTS = ("original", "optimized")


class OptimizeRequest(BaseModel):
    target_ratio: float = Field(0.5, gt=0.0, le=1.0, description="Fraction of triangles to keep")
    target_faces: int | None = Field(None, gt=0, description="Overrides target_ratio when set")
    merge_vertices: bool = True
    remove_degenerate: bool = True
    fix_normals: bool = True
    fill_holes: bool = False


class AssetError(Exception):
    pass


# ── Loading ──────────────────────────────────────────────
def load_scene(path: Path) -> trimesh.Scene:
    try:
        loaded = trimesh.load(str(path), force="scene", process=False)
    except Exception as exc:  # trimesh raises many different types for bad files
        raise AssetError(f"Could not read {path.name}: {exc}") from exc
    meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh) and len(g.faces)]
    if not meshes:
        raise AssetError(f"{path.name} contains no triangle meshes.")
    return loaded


def scene_meshes(scene: trimesh.Scene) -> list[trimesh.Trimesh]:
    return [g for g in scene.geometry.values() if isinstance(g, trimesh.Trimesh) and len(g.faces)]


# ── Analysis ─────────────────────────────────────────────
def _uv_overlap(meshes: list[trimesh.Trimesh], resolution: int = 1024) -> float | None:
    """Fraction of UV area that is covered more than once (stacked or overlapping islands)."""
    tris_list = []
    for mesh in meshes:
        uv = getattr(mesh.visual, "uv", None)
        if uv is None or len(uv) != len(mesh.vertices):
            continue
        tris_list.append(np.asarray(uv, dtype=np.float64)[mesh.faces])
    if not tris_list:
        return None
    tris = np.concatenate(tris_list)
    if len(tris) > 200_000:
        tris = tris[np.random.default_rng(0).choice(len(tris), 200_000, replace=False)]
    # Wrap tiled UVs into the unit square so tiling does not count as overlap.
    tris = tris - np.floor(tris.min(axis=1, keepdims=True))
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    areas = 0.5 * np.abs((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1]))
    total = float(areas.sum())
    if total <= 1e-12:
        return None
    image = Image.new("L", (resolution, resolution), 0)
    draw = ImageDraw.Draw(image)
    pixels = tris * resolution
    for tri in pixels:
        draw.polygon([tuple(p) for p in tri], fill=255)
    covered = np.count_nonzero(np.asarray(image)) / float(resolution * resolution)
    return float(max(0.0, min(1.0, 1.0 - covered / total)))


def _material_maps(meshes: list[trimesh.Trimesh]) -> dict[str, bool]:
    maps = {"albedo": False, "normal": False, "occlusion": False, "metallic_roughness": False}
    for mesh in meshes:
        material = getattr(mesh.visual, "material", None)
        if material is None:
            continue
        if isinstance(material, trimesh.visual.material.SimpleMaterial):
            material = material.to_pbr()
        maps["albedo"] |= getattr(material, "baseColorTexture", None) is not None
        maps["normal"] |= getattr(material, "normalTexture", None) is not None
        maps["occlusion"] |= getattr(material, "occlusionTexture", None) is not None
        maps["metallic_roughness"] |= getattr(material, "metallicRoughnessTexture", None) is not None
    return maps


def _sample_points(scene: trimesh.Scene, count: int = 20_000) -> np.ndarray:
    mesh = scene.to_mesh() if hasattr(scene, "to_mesh") else scene.dump(concatenate=True)
    points, _ = trimesh.sample.sample_surface(mesh, count, seed=0)
    return np.asarray(points)


def hausdorff(original: trimesh.Scene, optimized: trimesh.Scene) -> float:
    """Symmetric Hausdorff distance between sampled surfaces, relative to the bounding-box diagonal."""
    a = _sample_points(original)
    b = _sample_points(optimized)
    d_ab = cKDTree(b).query(a)[0].max()
    d_ba = cKDTree(a).query(b)[0].max()
    diagonal = float(np.linalg.norm(original.extents)) or 1.0
    return float(max(d_ab, d_ba) / diagonal)


def analyze(scene: trimesh.Scene, file_size: int, fidelity: float | None = None) -> dict:
    meshes = scene_meshes(scene)
    faces = sum(len(m.faces) for m in meshes)
    vertices = sum(len(m.vertices) for m in meshes)
    # Topology checks run on a welded copy: STL stores unshared vertices and glTF
    # splits vertices along UV/normal seams, which would otherwise read as open edges.
    welded = []
    for mesh in meshes:
        copy = trimesh.Trimesh(vertices=mesh.vertices, faces=mesh.faces, process=False)
        copy.merge_vertices(merge_tex=True, merge_norm=True)
        welded.append(copy)
    watertight = all(m.is_watertight for m in welded)
    winding = all(m.is_winding_consistent for m in welded)
    degenerate = int(sum(int((~m.nondegenerate_faces()).sum()) for m in welded))
    has_uv = any(getattr(m.visual, "uv", None) is not None for m in meshes)
    uv_overlap = _uv_overlap(meshes)
    maps = _material_maps(meshes)

    checks = []

    health_issues = []
    if not watertight:
        health_issues.append("not watertight")
    if not winding:
        health_issues.append("inconsistent winding")
    if degenerate:
        health_issues.append(f"{degenerate:,} degenerate faces")
    checks.append({
        "id": "mesh_health",
        "status": "pass" if not health_issues else ("warn" if winding else "fail"),
        "value": "Watertight" if not health_issues else ", ".join(health_issues).capitalize(),
    })

    checks.append({
        "id": "asset_weight",
        "status": "pass" if faces <= TRIANGLE_BUDGET else ("warn" if faces <= TRIANGLE_BUDGET * 5 else "fail"),
        "value": f"{faces:,} tris",
    })

    if not has_uv:
        checks.append({"id": "texture_atlas", "status": "warn", "value": "No UVs"})
    elif uv_overlap is None:
        checks.append({"id": "texture_atlas", "status": "warn", "value": "Empty UVs"})
    else:
        pct = uv_overlap * 100
        checks.append({
            "id": "texture_atlas",
            "status": "pass" if pct < 1 else ("warn" if pct < 10 else "fail"),
            "value": f"{pct:.1f}% overlap",
        })

    present = [name for name, ok in maps.items() if ok]
    checks.append({
        "id": "pbr_completeness",
        "status": "pass" if maps["albedo"] and maps["normal"] else ("warn" if present else "fail"),
        "value": f"{len(present)}/4 maps" if present else "No textures",
        "detail": present,
    })

    if fidelity is None:
        checks.append({"id": "shape_fidelity", "status": "info", "value": "Baseline"})
    else:
        checks.append({
            "id": "shape_fidelity",
            "status": "pass" if fidelity <= FIDELITY_TOLERANCE else ("warn" if fidelity <= FIDELITY_TOLERANCE * 3 else "fail"),
            "value": f"{fidelity * 100:.2f}% of size",
        })

    return {
        "stats": {
            "meshes": len(meshes),
            "faces": faces,
            "vertices": vertices,
            "file_size": file_size,
            "extents": [float(x) for x in scene.extents],
            "watertight": watertight,
            "winding_consistent": winding,
            "degenerate_faces": degenerate,
            "has_uv": has_uv,
            "uv_overlap": uv_overlap,
            "texture_maps": maps,
            "hausdorff": fidelity,
        },
        "checks": checks,
    }


# ── Optimisation ─────────────────────────────────────────
def _quadric_collapse(vertices: np.ndarray, faces: np.ndarray, target_faces: int, optimal_placement: bool):
    import pymeshlab

    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=np.asarray(vertices, dtype=np.float64),
                               face_matrix=np.asarray(faces, dtype=np.int32)))
    ms.meshing_decimation_quadric_edge_collapse(
        targetfacenum=int(target_faces),
        preservenormal=True,
        preserveboundary=True,
        preservetopology=True,
        optimalplacement=optimal_placement,
        qualitythr=0.5,
    )
    out = ms.current_mesh()
    return out.vertex_matrix(), out.face_matrix()


def _decimate(mesh: trimesh.Trimesh, target_faces: int) -> trimesh.Trimesh:
    """Quadric decimation of the mesh's shape only (visuals are re-projected afterwards).

    glTF/OBJ meshes are split along every UV and normal seam. Those seams look like
    open cracks to the decimator, and its optimal-placement solve can fling vertices
    far outside the model there. So the shape is welded first, and the result is
    checked against the original bounds, falling back to safe placement if needed.
    """
    welded = trimesh.Trimesh(vertices=mesh.vertices, faces=mesh.faces, process=False)
    welded.merge_vertices(merge_tex=True, merge_norm=True)

    lower, upper = mesh.bounds
    margin = 0.05 * float(np.linalg.norm(upper - lower))
    for optimal_placement in (True, False):
        vertices, faces = _quadric_collapse(welded.vertices, welded.faces, target_faces, optimal_placement)
        inside = np.all((vertices >= lower - margin) & (vertices <= upper + margin))
        if len(faces) and np.isfinite(vertices).all() and inside:
            return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    raise AssetError("Decimation produced vertices outside the model; try a higher triangle target.")


def _transfer_visuals(source: trimesh.Trimesh, target: trimesh.Trimesh) -> trimesh.Trimesh:
    """Return *target* with UVs / colours carried over from *source*.

    UVs are re-projected per face: each new triangle finds the original triangle it
    lies on and takes its corner UVs from that triangle's UV layout. Corners are
    then re-shared wherever position and UV agree, so texture seams stay seams
    instead of a triangle stretching across the atlas.
    """
    visual = source.visual
    if visual is None:
        return target
    uv = getattr(visual, "uv", None)
    if uv is not None and len(uv) == len(source.vertices):
        uv = np.asarray(uv, dtype=np.float64)
        src_tris = source.triangles
        new_tris = target.triangles
        centroids = new_tris.mean(axis=1)

        # Nearest few original triangles by centroid, then pick the one the new centroid is truly closest to.
        k = min(8, len(src_tris))
        _, candidates = cKDTree(src_tris.mean(axis=1)).query(centroids, k=k)
        candidates = np.asarray(candidates).reshape(len(centroids), k)
        closest = trimesh.triangles.closest_point(
            src_tris[candidates.ravel()], np.repeat(centroids, k, axis=0))
        distance = np.linalg.norm(closest - np.repeat(centroids, k, axis=0), axis=1).reshape(-1, k)
        chosen = candidates[np.arange(len(candidates)), distance.argmin(axis=1)]

        # Barycentric coordinates of each new corner on its chosen original triangle (clamped onto it).
        corner_tris = np.repeat(src_tris[chosen], 3, axis=0)
        bary = trimesh.triangles.points_to_barycentric(corner_tris, new_tris.reshape(-1, 3))
        bary = np.clip(np.nan_to_num(bary, nan=1.0 / 3.0), 0.0, None)
        bary /= np.maximum(bary.sum(axis=1, keepdims=True), 1e-12)
        corner_uv = np.einsum("ij,ijk->ik", bary, np.repeat(uv[source.faces[chosen]], 3, axis=0))

        result = trimesh.Trimesh(
            vertices=new_tris.reshape(-1, 3),
            faces=np.arange(len(new_tris) * 3).reshape(-1, 3),
            process=False,
        )
        result.visual = trimesh.visual.TextureVisuals(uv=corner_uv, material=visual.material)
        result.merge_vertices(merge_tex=False, merge_norm=True)
        return result

    index = cKDTree(source.vertices).query(target.vertices)[1]
    if visual.kind == "vertex":
        target.visual = trimesh.visual.ColorVisuals(target, vertex_colors=np.asarray(visual.vertex_colors)[index])
    elif visual.kind == "face":
        target.visual = trimesh.visual.ColorVisuals(target, face_colors=np.tile(visual.main_color, (len(target.faces), 1)))
    elif hasattr(visual, "material"):
        target.visual = trimesh.visual.TextureVisuals(material=visual.material)
    return target


def optimize_scene(scene: trimesh.Scene, req: OptimizeRequest) -> trimesh.Scene:
    """Optimise *scene* in place and return it.

    Not copied on purpose: copying the materials drops each PIL image's JPEG
    format tag, and the GLB exporter then re-encodes every texture as PNG
    (several times larger). The originals are re-attached below for the same reason.
    """
    meshes = scene_meshes(scene)
    total = sum(len(m.faces) for m in meshes)
    goal_total = req.target_faces if req.target_faces else int(total * req.target_ratio)

    for name, geometry in list(scene.geometry.items()):
        if not isinstance(geometry, trimesh.Trimesh) or not len(geometry.faces):
            continue
        mesh = geometry.copy()
        if req.merge_vertices:
            mesh.merge_vertices()
        if req.remove_degenerate:
            mesh.update_faces(mesh.nondegenerate_faces())
            mesh.update_faces(mesh.unique_faces())
            mesh.remove_unreferenced_vertices()
        if req.fill_holes:
            trimesh.repair.fill_holes(mesh)
        if req.fix_normals:
            trimesh.repair.fix_normals(mesh)

        # Split the face budget across meshes in proportion to their size.
        target = max(4, int(round(goal_total * len(geometry.faces) / max(total, 1))))
        if target < len(mesh.faces):
            reduced = _transfer_visuals(mesh, _decimate(mesh, target))
            if req.fix_normals:
                trimesh.repair.fix_normals(reduced)
            mesh = reduced
        original_material = getattr(geometry.visual, "material", None)
        if original_material is not None and hasattr(mesh.visual, "material"):
            mesh.visual.material = original_material
        scene.geometry[name] = mesh
    return scene


# ── Storage ──────────────────────────────────────────────
class AssetStore:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def folder(self, asset_id: str) -> Path:
        if not asset_id.isalnum():
            raise HTTPException(400, "invalid asset id")
        folder = self.root / asset_id
        if not folder.is_dir():
            raise HTTPException(404, "asset not found")
        return folder

    def meta(self, asset_id: str) -> dict:
        return json.loads((self.folder(asset_id) / "meta.json").read_text(encoding="utf-8"))

    def _save_meta(self, folder: Path, meta: dict) -> dict:
        (folder / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        return meta

    def create(self, name: str, source: Path) -> dict:
        asset_id = uuid.uuid4().hex
        folder = self.root / asset_id
        folder.mkdir()
        try:
            kept = folder / f"source{source.suffix.lower()}"
            shutil.copyfile(source, kept)
            scene = load_scene(kept)
            glb = folder / "original.glb"
            scene.export(str(glb), file_type="glb")
            report = analyze(scene, glb.stat().st_size)
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        return self._save_meta(folder, {
            "id": asset_id,
            "name": name,
            "source_format": source.suffix.lower().lstrip("."),
            "original": report,
            "optimized": None,
            "settings": None,
        })

    def optimize(self, asset_id: str, req: OptimizeRequest) -> dict:
        folder = self.folder(asset_id)
        meta = self.meta(asset_id)
        original = load_scene(folder / "original.glb")
        optimized = optimize_scene(load_scene(folder / "original.glb"), req)
        out = folder / "optimized.glb"
        optimized.export(str(out), file_type="glb")
        reloaded = load_scene(out)
        meta["optimized"] = analyze(reloaded, out.stat().st_size, fidelity=hausdorff(original, reloaded))
        meta["settings"] = req.model_dump()
        return self._save_meta(folder, meta)

    def file(self, asset_id: str, variant: str) -> Path:
        if variant not in VARIANTS:
            raise HTTPException(400, "variant must be 'original' or 'optimized'")
        path = self.folder(asset_id) / f"{variant}.glb"
        if not path.exists():
            raise HTTPException(404, f"no {variant} model yet")
        return path


# ── Routes ───────────────────────────────────────────────
def build_router(outputs: Path, uploads: Path, resolve_run_output) -> APIRouter:
    store = AssetStore(outputs / "assets")
    router = APIRouter(prefix="/assets", tags=["assets"])

    @router.post("/import")
    async def import_asset(file: UploadFile = File(...)):
        name = Path(file.filename or "model").name
        suffix = Path(name).suffix.lower()
        if suffix not in SUPPORTED_SUFFIXES:
            raise HTTPException(400, f"Unsupported format '{suffix or name}'. Use: {', '.join(sorted(SUPPORTED_SUFFIXES))}.")
        data = await file.read()
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "File is larger than 512 MB.")
        tmp = uploads / f"asset-{uuid.uuid4().hex}{suffix}"
        tmp.write_bytes(data)
        try:
            return store.create(name, tmp)
        except AssetError as exc:
            raise HTTPException(400, str(exc))
        finally:
            tmp.unlink(missing_ok=True)

    @router.post("/from-run/{run_id}")
    def import_run_output(run_id: str):
        path = resolve_run_output(run_id)
        try:
            return store.create(f"run-{run_id[:8]}.glb", Path(path))
        except AssetError as exc:
            raise HTTPException(400, str(exc))

    @router.get("/{asset_id}")
    def get_asset(asset_id: str):
        return store.meta(asset_id)

    @router.post("/{asset_id}/optimize")
    def optimize_asset(asset_id: str, req: OptimizeRequest):
        try:
            return store.optimize(asset_id, req)
        except AssetError as exc:
            raise HTTPException(400, str(exc))

    @router.get("/{asset_id}/file/{variant}")
    def get_asset_file(asset_id: str, variant: str):
        meta = store.meta(asset_id)
        stem = Path(meta["name"]).stem
        return FileResponse(store.file(asset_id, variant), media_type="model/gltf-binary",
                            filename=f"{stem}-{variant}.glb")

    return router
