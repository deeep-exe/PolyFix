import json
import importlib.util
import inspect
import os
import re
import shutil
import stat
import threading
import uuid
from pathlib import Path
from typing import Optional

from ..extensions import EXT_DIR, check_cuda_and_deps
from ..storage import CATEGORIES, category_for, iter_model_folders, model_path


HF_RE = re.compile(
    r"^(?:https?://(?:www\.)?huggingface\.co/)?"
    r"([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)"
    r"(?:/.*)?/?$",
    re.IGNORECASE,
)


def _resolve_extension_folder(extension_id: str) -> Path | None:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", extension_id):
        return None
    direct = EXT_DIR / extension_id
    if direct.is_dir():
        return direct
    folders = list(EXT_DIR.iterdir()) if EXT_DIR.exists() else []
    folders.extend(iter_model_folders())
    for folder in folders:
        manifest_file = folder / "manifest.json"
        if not folder.is_dir() or not manifest_file.exists():
            continue
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
            if manifest.get("id") == extension_id:
                return folder
        except Exception:
            continue
    return None


def validate_node_signature(extension_id: str) -> dict:
    folder = _resolve_extension_folder(extension_id)
    if folder is None:
        return {
            "valid": False,
            "expected_params": [],
            "accepts_var_kwargs": False,
            "message": "Extension not found.",
        }

    manifest_file = folder / "manifest.json"
    entry_name = "generator.py"
    if manifest_file.exists():
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
            entry_name = manifest.get("entry", "generator.py")
        except Exception as exc:
            return {
                "valid": False,
                "expected_params": [],
                "accepts_var_kwargs": False,
                "message": f"Could not read extension manifest: {exc}",
            }

    entry_file = folder / entry_name
    if not entry_file.exists():
        return {
            "valid": False,
            "expected_params": [],
            "accepts_var_kwargs": False,
            "message": "Generator entry file is missing.",
        }

    try:
        spec = importlib.util.spec_from_file_location(
            f"polyfix_{re.sub(r'[^a-zA-Z0-9_]', '_', extension_id)}_preflight",
            entry_file,
        )
        if spec is None or spec.loader is None:
            raise ImportError("Could not create an import specification for generator.py.")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        generate_fn = getattr(module, "generate", None)
        if not callable(generate_fn):
            raise AttributeError("generator.py does not define a callable generate().")

        signature = inspect.signature(generate_fn)
        expected_params = [
            parameter.name
            for parameter in signature.parameters.values()
            if parameter.kind in (
                inspect.Parameter.POSITIONAL_ONLY,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
                inspect.Parameter.KEYWORD_ONLY,
            )
        ]
        accepts_var_kwargs = any(
            parameter.kind == inspect.Parameter.VAR_KEYWORD
            for parameter in signature.parameters.values()
        )
        return {
            "valid": True,
            "expected_params": expected_params,
            "accepts_var_kwargs": accepts_var_kwargs,
            "message": "Generator signature is valid.",
        }
    except Exception as exc:
        return {
            "valid": False,
            "expected_params": [],
            "accepts_var_kwargs": False,
            "message": f"Invalid generator signature: {exc}",
        }


def execute_extension_safely(
    generate_fn,
    run=None,
    image_path=None,
    params=None,
    output_dir=None,
    run_id=None,
):
    if not callable(generate_fn):
        raise TypeError("Extension generate entry is not callable.")

    signature = inspect.signature(generate_fn)
    parameters = signature.parameters
    accepts_var_kwargs = any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in parameters.values()
    )
    if run_id is None and run is not None:
        run_id = getattr(run, "id", None)

    payload = {
        "image_path": image_path,
        "params": params,
        "output_dir": output_dir,
        "run_id": run_id,
    }
    filtered_kwargs = {}

    for name, parameter in parameters.items():
        if parameter.kind == inspect.Parameter.VAR_POSITIONAL:
            continue
        if parameter.kind == inspect.Parameter.VAR_KEYWORD:
            continue
        if name == "run" and run is not None:
            filtered_kwargs[name] = run
        elif name == "out_dir" and output_dir is not None:
            filtered_kwargs[name] = output_dir
        elif name in payload and payload[name] is not None:
            filtered_kwargs[name] = payload[name]

    if accepts_var_kwargs:
        for name, value in payload.items():
            if value is not None:
                filtered_kwargs[name] = value
        if run is not None:
            filtered_kwargs.setdefault("run", run)
        if output_dir is not None:
            filtered_kwargs.setdefault("out_dir", output_dir)

    try:
        signature.bind(**filtered_kwargs)
    except TypeError as exc:
        raise TypeError(f"Extension argument mismatch: {exc}") from exc
    return generate_fn(**filtered_kwargs)


class ModelImportError(Exception):
    pass


class ModelManager:
    def __init__(self):
        self.tasks: dict[str, dict] = {}
        self._lock = threading.Lock()

    def parse_repo(self, value: str) -> tuple[str, str, str]:
        value = value.strip()
        match = HF_RE.match(value)
        if not match:
            raise ModelImportError(
                "Invalid Hugging Face repository. Use owner/model or "
                "https://huggingface.co/owner/model."
            )
        owner, name = match.group(1).lower(), match.group(2).lower()
        name = name[:-4] if name.endswith(".git") else name
        repo_id = f"{owner}/{name}"
        model_id = re.sub(r"[^a-z0-9]+", "-", repo_id).strip("-")
        source_url = f"https://huggingface.co/{repo_id}"
        return repo_id, model_id, source_url

    def prepare(self, value: str) -> tuple[str, str, str]:
        repo_id, model_id, source_url = self.parse_repo(value)
        target = model_path(model_id, category_for(source_url=source_url))
        if target.exists():
            raise ModelImportError(f'Model "{model_id}" is already installed.')
        return repo_id, model_id, source_url

    def create_task(self, model_id: str) -> str:
        task_id = uuid.uuid4().hex
        with self._lock:
            self.tasks[task_id] = {
                "task_id": task_id,
                "model_id": model_id,
                "status": "downloading",
                "progress": 0,
                "error": None,
                "eta": None,
            }
        return task_id

    def get_task(self, task_id: str) -> Optional[dict]:
        with self._lock:
            task = self.tasks.get(task_id)
            return dict(task) if task else None

    def _update_task(self, task_id: str, **changes):
        with self._lock:
            if task_id in self.tasks:
                self.tasks[task_id].update(changes)

    def run_import(
        self,
        task_id: str,
        repo_id: str,
        model_id: str,
        source_url: str,
    ):
        category = category_for(source_url=source_url)
        target = model_path(model_id, category)
        temp = target.parent / f".tmp-{uuid.uuid4().hex[:8]}"
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            free_space = shutil.disk_usage(target.parent).free
            if free_space < 100 * 1024 * 1024:
                raise ModelImportError("Insufficient disk space.")

            self._update_task(task_id, progress=10, eta="Preparing download...")
            try:
                from huggingface_hub import snapshot_download
            except ImportError:
                raise ModelImportError(
                    "huggingface_hub is not installed. Add it to backend requirements."
                )

            token = os.getenv("HF_TOKEN")
            try:
                snapshot_download(
                    repo_id=repo_id,
                    local_dir=str(temp),
                    local_dir_use_symlinks=False,
                    cache_dir=str(CATEGORIES["cache"] / "huggingface" / "hub"),
                    token=token,
                )
            except TypeError:
                snapshot_download(
                    repo_id=repo_id,
                    local_dir=str(temp),
                    cache_dir=str(CATEGORIES["cache"] / "huggingface" / "hub"),
                    token=token,
                )
            except Exception as e:
                message = str(e)
                if "401" in message or "gated" in message.lower():
                    raise ModelImportError(
                        "This Hugging Face repository requires an access token (HF_TOKEN)."
                    )
                raise ModelImportError(f"Hugging Face download failed: {message}")

            self._update_task(task_id, progress=85, eta="Writing model manifest...")
            manifest = {
                "id": model_id,
                "name": self.clean_name(repo_id),
                "version": "1.0.0",
                "type": "model",
                "entry": "generator.py",
                "requires_gpu": True,
                "source_url": source_url,
                "storage_category": category,
            }
            (temp / "manifest.json").write_text(
                json.dumps(manifest, indent=2),
                encoding="utf-8",
            )
            entry = temp / "generator.py"
            if not entry.exists():
                entry.write_text(
                    "def generate(image_path, output_dir, params=None, *args, **kwargs):\n"
                    "    raise RuntimeError('This Hugging Face model needs a compatible generator implementation.')\n",
                    encoding="utf-8",
                )

            temp.rename(target)
            self._update_task(
                task_id,
                status="completed",
                progress=100,
                error=None,
                eta=None,
            )
        except Exception as e:
            if temp.exists():
                shutil.rmtree(temp, ignore_errors=True)
            message = str(e)
            self._update_task(
                task_id,
                status="failed",
                progress=0,
                error=message,
                eta=None,
            )

    def clean_name(self, repo_id: str) -> str:
        name = repo_id.split("/")[-1]
        return re.sub(r"[-_]+", " ", name).strip().title()

    def list_models(self, installed: dict) -> list:
        models = []
        folders = list(EXT_DIR.iterdir()) if EXT_DIR.exists() else []
        folders.extend(iter_model_folders())
        for folder in sorted(folders, key=lambda p: p.name.lower()):
            if not folder.is_dir():
                continue
            manifest_file = folder / "manifest.json"
            if not manifest_file.exists():
                continue
            try:
                manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
            except Exception:
                continue
            if manifest.get("type") not in {"model", "demo", "extension"}:
                continue

            size = sum(
                p.stat().st_size for p in folder.rglob("*") if p.is_file()
            )
            weight_path = manifest.get("weights_path")
            if weight_path:
                resolved_weights = Path(__file__).resolve().parents[4] / Path(weight_path)
                if resolved_weights.is_dir():
                    size += sum(p.stat().st_size for p in resolved_weights.rglob("*") if p.is_file())
            entry = folder / manifest.get("entry", "generator.py")
            ext = installed.get(manifest.get("id"))
            if manifest.get("requires_gpu"):
                is_ready, status_message = check_cuda_and_deps(entry)
            elif ext:
                is_ready = bool(ext["manifest"].get("is_ready"))
                status_message = ext["manifest"].get("status_message", "Ready")
            else:
                is_ready = True
                status_message = "Mock / Demo"

            storage_category = manifest.get("storage_category") or (
                folder.parent.name if folder.parent.name in {"image-to-3d", "text-to-3d", "mesh-repair", "preprocessors", "bin"}
                else "extensions"
            )
            storage_location = str(Path(weight_path).as_posix()) if weight_path else (
                f"models/{storage_category}/{folder.name}" if storage_category != "extensions"
                else f"extensions/{folder.name}"
            )
            models.append({
                "id": manifest.get("id", folder.name),
                "name": manifest.get("name", self.clean_name(folder.name)),
                "version": manifest.get("version", "1.0.0"),
                "type": manifest.get("type", "model"),
                "source_url": manifest.get("source_url", ""),
                "local_path": storage_location,
                "storage_category": storage_category,
                "removable": bool(manifest.get("source_url") and not weight_path),
                "size_bytes": size,
                "installed": True,
                "cuda_ready": is_ready,
                "status": status_message,
                "requires_gpu": bool(manifest.get("requires_gpu")),
            })
        return models

    def delete_model(self, model_id: str):
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", model_id):
            raise ModelImportError("Invalid model id.")
        folder = next((path for path in iter_model_folders() if path.name == model_id), EXT_DIR / model_id)
        if not folder.exists() or not folder.is_dir():
            raise ModelImportError("Model not found.")

        manifest_file = folder / "manifest.json"
        imported = False
        if manifest_file.exists():
            try:
                manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
                if manifest.get("weights_path"):
                    raise ModelImportError("This model's weights are bundled with an extension and cannot be deleted separately.")
                imported = bool(manifest.get("source_url") or (folder / "source.txt").exists())
            except ModelImportError:
                raise
            except Exception:
                imported = False
        if not imported:
            raise ModelImportError("Only imported Hugging Face models can be deleted here.")

        shutil.rmtree(folder, onerror=self._unlock_and_retry)

    @staticmethod
    def _unlock_and_retry(func, path, _exc_info):
        os.chmod(path, stat.S_IWRITE)
        func(path)


model_manager = ModelManager()
