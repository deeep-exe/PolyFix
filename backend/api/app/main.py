import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import extensions, installer
from .runs import RunManager


# ── Setup ────────────────────────────────────────────────
BASE = Path(__file__).resolve().parent.parent
UPLOADS = BASE / "uploads"
OUTPUTS = BASE / "outputs"
UPLOADS.mkdir(exist_ok=True)
OUTPUTS.mkdir(exist_ok=True)

app = FastAPI()

# CORS: lets the React app (on port 5173) talk to this server (port 8000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

manager = RunManager()
installed = extensions.load_all()


class InstallRequest(BaseModel):
    url: str
 
def reload_extensions():
    installed.clear()  # keep the same dict, so create_run still sees it
    installed.update(extensions.load_all())



def get_run_or_404(run_id: str):
    run = manager.runs.get(run_id)
    if not run:
        raise HTTPException(404, "run not found")
    return run


# ── Routes ───────────────────────────────────────────────
@app.get("/health")
def health():
    return {"ok": True}


@app.get("/extensions")
def list_extensions():
    return [e["manifest"] for e in installed.values()]


@app.post("/extensions/install")
def install_extension(req: InstallRequest):
    try:
        manifest = installer.install_from_github(req.url)
    except installer.InstallError as e:
        raise HTTPException(400, str(e))
 
    reload_extensions()
    if manifest["id"] not in installed:
        installer.uninstall(manifest["id"])  # it would not load: undo
        raise HTTPException(400, "Downloaded, but the extension could not be loaded.")
    return manifest
 
@app.delete("/extensions/{ext_id}")
def remove_extension(ext_id: str):
    try:
        installer.uninstall(ext_id)
    except installer.InstallError as e:
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