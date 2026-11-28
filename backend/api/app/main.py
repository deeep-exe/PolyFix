import os
import subprocess
import sys
import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import assets, extensions, installer
from .routers import extensions as extensions_router
from .runs import RunManager
from .services.dependency_manager import audit_extension, install_missing_for_extension
from .services.downloader import extension_downloader
from .services.model_manager import ModelImportError, model_manager, validate_node_signature


# ── Setup ────────────────────────────────────────────────
BASE = Path(__file__).resolve().parent.parent
UPLOADS = BASE / "uploads"
OUTPUTS = BASE / "outputs"
UPLOADS.mkdir(exist_ok=True)
OUTPUTS.mkdir(exist_ok=True)

app = FastAPI()

# CORS: lets the React app (Vite dev server or Electron file:// origin) talk to this server
_extra_origins = [
    origin.strip()
    for origin in os.environ.get("POLYFIX_CORS_ORIGINS", "").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "null",
        *_extra_origins,
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(extensions_router.router)

manager = RunManager()
installed = extensions.load_all()


class InstallRequest(BaseModel):
    url: str


class DepsInstallRequest(BaseModel):
    packages: list[str] | None = None


class ModelImportRequest(BaseModel):
    hf_url: str


def reload_extensions():
    installed.clear()  # keep the same dict, so create_run still sees it
    installed.update(extensions.load_all())


def get_run_or_404(run_id: str):
    run = manager.runs.get(run_id)
    if not run:
        raise HTTPException(404, "run not found")
    return run


def get_run_output_or_409(run_id: str) -> str:
    r = get_run_or_404(run_id)
    if r.status != "done" or not r.output_path:
        raise HTTPException(409, "not ready yet")
    return r.output_path


app.include_router(assets.build_router(OUTPUTS, UPLOADS, get_run_output_or_409))


# ── Routes ───────────────────────────────────────────────
@app.get("/health")
def health():
    return {"ok": True}


@app.get("/extensions")
def list_extensions():
    reload_extensions()
    items = []
    for ext_id, entry in installed.items():
        manifest = dict(entry["manifest"])
        audit = audit_extension(ext_id)
        manifest["is_ready"] = bool(audit.get("is_ready", True))
        if manifest.get("generator_notice"):
            manifest["status_message"] = manifest["generator_notice"]
        elif audit.get("missing_packages"):
            manifest["status_message"] = f"Missing packages: {', '.join(audit['missing_packages'])}"
        elif audit.get("error"):
            manifest["status_message"] = audit["error"]
        elif manifest.get("requires_gpu") and not audit.get("cuda_available"):
            manifest["status_message"] = "CUDA is not available."
        else:
            manifest["status_message"] = "Ready"
        manifest.setdefault("removable", bool(manifest.get("source_url")))
        items.append(manifest)
    return items


@app.post("/extensions/install")
def install_extension(req: InstallRequest):
    try:
        task_id = extension_downloader.start(req.url)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"task_id": task_id, "status": "downloading"}


@app.post("/extensions/install/upload")
async def install_extension_zip(file: UploadFile = File(...)):
    filename = (file.filename or "").lower()
    if not filename.endswith(".zip"):
        raise HTTPException(400, "Only .zip extension archives are supported.")
    tmp_zip = UPLOADS / f"ext-{uuid.uuid4().hex}.zip"
    tmp_zip.write_bytes(await file.read())
    task_id = extension_downloader.start_local_zip(tmp_zip)
    return {"task_id": task_id, "status": "downloading"}


@app.get("/extensions/downloads")
def list_extension_downloads():
    tasks = extension_downloader.list_tasks()
    if any(task.get("status") == "completed" for task in tasks):
        reload_extensions()
    return tasks


@app.delete("/extensions/downloads/{task_id}")
def cancel_extension_download(task_id: str):
    if not extension_downloader.cancel(task_id):
        raise HTTPException(404, "Download task not found or already finished.")
    return {"ok": True}


@app.get("/extensions/{ext_id}/deps")
def get_extension_deps(ext_id: str):
    return audit_extension(ext_id)


@app.post("/extensions/{ext_id}/install-deps")
@app.post("/extensions/{ext_id}/deps/install")
def install_extension_deps(ext_id: str, req: DepsInstallRequest | None = None):
    result = install_missing_for_extension(ext_id, req.packages if req else None)
    reload_extensions()
    return result


@app.get("/extensions/{ext_id}/preflight")
def get_extension_preflight(ext_id: str):
    return validate_node_signature(ext_id)


@app.delete("/extensions/{ext_id}")
def remove_extension(ext_id: str):
    try:
        installer.uninstall(ext_id)
    except installer.InstallError:
        try:
            model_manager.delete_model(ext_id)
        except ModelImportError as e:
            raise HTTPException(400, str(e))
    reload_extensions()
    return {"ok": True}


@app.get("/models")
def list_models():
    reload_extensions()
    return model_manager.list_models(installed)


@app.post("/models/import")
def import_model(req: ModelImportRequest):
    try:
        repo_id, model_id, source_url = model_manager.prepare(req.hf_url)
    except ModelImportError as e:
        raise HTTPException(400, str(e))

    task_id = model_manager.create_task(model_id)
    thread = threading.Thread(
        target=model_manager.run_import,
        args=(task_id, repo_id, model_id, source_url),
        daemon=True,
    )
    thread.start()
    return {"task_id": task_id, "model_id": model_id}


@app.get("/models/status/{task_id}")
def get_model_status(task_id: str):
    task = model_manager.get_task(task_id)
    if not task:
        raise HTTPException(404, "Model import task not found.")
    if task.get("status") == "completed":
        reload_extensions()
    return task


@app.delete("/models/{model_id}")
def delete_model(model_id: str):
    try:
        model_manager.delete_model(model_id)
    except ModelImportError as e:
        raise HTTPException(400, str(e))
    reload_extensions()
    return {"ok": True}


@app.post("/runs")
async def create_run(
    image: UploadFile = File(...),
    extension_id: str = Form(...),
):
    ext = installed.get(extension_id)
    if not ext:
        raise HTTPException(400, "unknown extension")

    suffix = Path(image.filename or "").suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise HTTPException(400, "unsupported image type")

    path = UPLOADS / f"{uuid.uuid4().hex}{suffix}"
    path.write_bytes(await image.read())

    run = manager.submit(ext["generate"], str(path), str(OUTPUTS))
    return {"id": run.id, "status": run.status}


@app.get("/runs/{run_id}")
def get_run(run_id: str):
    r = get_run_or_404(run_id)
    return {
        "id": r.id,
        "status": r.status,
        "progress": r.progress,
        "error": r.error,
    }


@app.get("/runs/{run_id}/result")
def get_result(run_id: str):
    r = get_run_or_404(run_id)
    if r.status != "done":
        raise HTTPException(409, "not ready yet")
    return FileResponse(r.output_path, media_type="model/gltf-binary")


@app.delete("/runs/{run_id}")
def cancel_run(run_id: str):
    get_run_or_404(run_id).cancel.set()
    return {"ok": True}
