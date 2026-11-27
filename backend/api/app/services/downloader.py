import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
import urllib.request
import zipfile
from pathlib import Path
from urllib.parse import urlparse

from ..storage import CATEGORIES, category_for, model_path
from .auto_generator import ensure_generator


active_downloads: dict[str, dict] = {}
_downloads_lock = threading.Lock()
_processes: dict[str, subprocess.Popen] = {}


def detect_source_type(value: str) -> str:
    value = value.strip()
    parsed = urlparse(value if "://" in value else f"https://{value}")
    host = (parsed.netloc or "").lower()
    path = parsed.path.lower()
    if host == "huggingface.co" or host.endswith(".huggingface.co"):
        return "huggingface"
    if host == "github.com" or host.endswith(".github.com"):
        return "github"
    if host and path.endswith(".zip"):
        return "zip"
    if not host and re.fullmatch(r"[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*", value):
        return "huggingface"
    if value.lower().endswith(".zip"):
        return "zip"
    raise ValueError(
        "Unsupported source. Use a GitHub URL, Hugging Face URL or repository ID, or ZIP URL."
    )


def clean_name(repo_id_or_url: str) -> str:
    value = repo_id_or_url.strip().rstrip("/").split("?")[0]
    name = value.rstrip("/").split("/")[-1].replace(".git", "")
    return re.sub(r"[-_]+", " ", name).strip().title() or "Imported Model"


def sanitize_id(name: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", name.lower().replace(".git", "")).strip("-")
    return value or f"extension-{uuid.uuid4().hex[:8]}"


def ensure_fallback_manifest(folder: Path, source_url: str) -> dict:
    manifest_file = folder / "manifest.json"
    if manifest_file.exists():
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
            if manifest.get("id") and manifest.get("entry"):
                manifest.setdefault("name", clean_name(source_url))
                manifest.setdefault("version", "0.1.0")
                manifest.setdefault("type", "model")
                manifest.setdefault("requires_gpu", True)
                manifest["source_url"] = source_url
                manifest["id"] = sanitize_id(str(manifest["id"]))
                manifest["storage_category"] = category_for(manifest, source_url)
                manifest_file.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
                return manifest
        except Exception:
            pass

    repo_name = clean_name(source_url)
    manifest = {
        "id": sanitize_id(repo_name),
        "name": repo_name,
        "version": "0.1.0",
        "type": "model",
        "entry": "generator.py",
        "requires_gpu": True,
        "source_url": source_url,
    }
    manifest["storage_category"] = category_for(manifest, source_url)
    ensure_generator(folder, manifest, source_url)
    manifest_file.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def folder_size(folder: Path) -> int:
    try:
        return sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())
    except OSError:
        return 0


def format_bytes(value: int) -> str:
    if value >= 1024 ** 3:
        return f"{value / 1024 ** 3:.2f} GB"
    if value >= 1024 ** 2:
        return f"{value / 1024 ** 2:.1f} MB"
    return f"{value / 1024:.0f} KB"


def _update(task_id: str, **changes):
    with _downloads_lock:
        if task_id in active_downloads:
            active_downloads[task_id].update(changes)


def _task_cancelled(task_id: str) -> bool:
    return active_downloads.get(task_id, {}).get("status") == "cancelled"


def _normalize_archive_root(folder: Path) -> Path:
    manifest = folder / "manifest.json"
    if manifest.exists():
        return folder
    children = [child for child in folder.iterdir() if child.is_dir()]
    if len(children) == 1:
        child = children[0]
        if (child / "manifest.json").exists() or (child / "generator.py").exists():
            return child
    return folder


class ExtensionDownloader:
    def start(self, url: str) -> str:
        source_type = detect_source_type(url)
        return self._create_task(url, source_type)

    def start_local_zip(self, path: Path) -> str:
        return self._create_task(str(path), "zip")

    def _create_task(self, url: str, source_type: str) -> str:
        task_id = uuid.uuid4().hex
        with _downloads_lock:
            active_downloads[task_id] = {
                "task_id": task_id,
                "url": url,
                "source_type": source_type,
                "name": clean_name(url),
                "progress": 0,
                "speed": 0,
                "downloaded_bytes": 0,
                "total_bytes": 0,
                "status": "downloading",
                "status_text": "Preparing download...",
                "notice": None,
                "error": None,
            }
        thread = threading.Thread(
            target=self._run,
            args=(task_id, url, source_type),
            name=f"extension-download-{task_id}",
            daemon=True,
        )
        thread.start()
        return task_id

    def cancel(self, task_id: str) -> bool:
        task = active_downloads.get(task_id)
        if not task or task["status"] != "downloading":
            return False
        _update(
            task_id,
            status="cancelled",
            status_text="Cancelled",
            error=None,
        )
        process = _processes.pop(task_id, None)
        if process and process.poll() is None:
            process.terminate()
        return True

    def list_tasks(self) -> list[dict]:
        with _downloads_lock:
            tasks = [dict(task) for task in active_downloads.values()]
            terminal_task_ids = [
                task_id
                for task_id, task in active_downloads.items()
                if task["status"] in {"completed", "failed", "cancelled"}
            ]
            for task_id in terminal_task_ids:
                del active_downloads[task_id]
            return tasks

    def get_task(self, task_id: str):
        with _downloads_lock:
            task = active_downloads.get(task_id)
            return dict(task) if task else None

    def _run(self, task_id: str, url: str, source_type: str):
        temp_root = CATEGORIES["image-to-3d"]
        temp_root.mkdir(parents=True, exist_ok=True)
        staging_dir = temp_root / f".tmp-{uuid.uuid4().hex[:8]}"
        temp = staging_dir
        try:
            if _task_cancelled(task_id):
                return
            if source_type == "github":
                self._download_github(task_id, url, temp)
            elif source_type == "huggingface":
                self._download_huggingface(task_id, url, temp)
            else:
                self._download_zip(task_id, url, temp)

            if _task_cancelled(task_id):
                return
            temp = _normalize_archive_root(temp)
            source_url = url if url.startswith("http") else (
                f"https://huggingface.co/{url.strip('/')}" if source_type == "huggingface" else url
            )
            _update(task_id, progress=88, status_text="Creating manifest and preparing extension...")
            manifest = ensure_fallback_manifest(temp, source_url)
            target_category = category_for(manifest, source_url)
            manifest["storage_category"] = target_category
            (temp / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            final = model_path(sanitize_id(str(manifest["id"])), target_category)
            if final.exists():
                raise RuntimeError(f'"{manifest["id"]}" is already installed.')
            git_dir = temp / ".git"
            if git_dir.exists():
                shutil.rmtree(git_dir, ignore_errors=True)
            temp.rename(final)
            (final / "source.txt").write_text(source_url, encoding="utf-8")
            notice = manifest.get("generator_notice")
            _update(
                task_id,
                progress=100,
                status="completed",
                status_text=notice or "Installed successfully",
                notice=notice,
                error=None,
            )
        except Exception as e:
            if not _task_cancelled(task_id):
                message = str(e)
                if "401" in message or "gated" in message.lower():
                    message = "This repository requires an access token (HF_TOKEN)."
                _update(
                    task_id,
                    status="failed",
                    status_text="Installation failed",
                    error=message,
                )
        finally:
            _processes.pop(task_id, None)
            if staging_dir.exists():
                shutil.rmtree(staging_dir, ignore_errors=True)

    def _download_github(self, task_id: str, url: str, temp: Path):
        _update(task_id, progress=5, status_text="Cloning repository...")
        clone_url = url.strip()
        if clone_url.endswith(".git") or urlparse(clone_url).path.endswith(".git"):
            pass
        process = subprocess.Popen(
            ["git", "clone", "--depth", "1", "--progress", "--", clone_url, str(temp)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
        _processes[task_id] = process
        output = process.stderr.read() if process.stderr else ""
        return_code = process.wait()
        if _task_cancelled(task_id):
            return
        if return_code != 0:
            raise RuntimeError(output.strip() or "Git clone failed. Check the repository URL.")
        _update(task_id, progress=82, status_text="Repository cloned; preparing files...")

    def _download_huggingface(self, task_id: str, url: str, temp: Path):
        try:
            from huggingface_hub import snapshot_download
        except ImportError:
            raise RuntimeError("huggingface_hub is not installed. Restart after installing backend requirements.")
        repo_id = url.strip().rstrip("/")
        if "huggingface.co/" in repo_id:
            repo_id = repo_id.split("huggingface.co/", 1)[1].strip("/")
        _update(task_id, progress=8, status_text=f"Downloading weights from {repo_id}...")
        stop = threading.Event()

        def monitor():
            started = time.monotonic()
            last_size = 0
            while not stop.wait(1):
                if _task_cancelled(task_id):
                    return
                size = folder_size(temp)
                elapsed = max(time.monotonic() - started, 0.001)
                speed = max(0, int((size - last_size) / 1))
                last_size = size
                progress = min(82, 8 + int(size / (1024 * 1024 * 1024) * 74)) if size else 10
                _update(
                    task_id,
                    progress=progress,
                    speed=speed,
                    downloaded_bytes=size,
                    status_text=f"Downloading weights ({format_bytes(size)})...",
                )

        monitor_thread = threading.Thread(target=monitor, daemon=True)
        monitor_thread.start()
        try:
            snapshot_download(
                repo_id=repo_id,
                local_dir=str(temp),
                local_dir_use_symlinks=False,
                cache_dir=str(CATEGORIES["cache"] / "huggingface" / "hub"),
                token=os.getenv("HF_TOKEN"),
            )
        finally:
            stop.set()
            monitor_thread.join(timeout=1)
        if not _task_cancelled(task_id):
            size = folder_size(temp)
            _update(
                task_id,
                progress=82,
                downloaded_bytes=size,
                status_text=f"Downloaded {format_bytes(size)}; preparing extension...",
            )

    def _download_zip(self, task_id: str, url: str, temp: Path):
        _update(task_id, progress=2, status_text="Downloading ZIP archive...")
        if os.path.isfile(url):
            local_archive = Path(url)
            temp.mkdir(parents=True, exist_ok=True)
            archive = temp / "_download.zip"
            shutil.copyfile(local_archive, archive)
            size = archive.stat().st_size
            _update(
                task_id,
                progress=78,
                downloaded_bytes=size,
                total_bytes=size,
                status_text=f"Extracting ZIP archive ({format_bytes(size)})...",
            )
            if _task_cancelled(task_id):
                return
            with zipfile.ZipFile(archive, "r") as zip_file:
                zip_file.extractall(temp)
            archive.unlink(missing_ok=True)
            try:
                local_archive.unlink(missing_ok=True)
            except OSError:
                pass
            _update(task_id, progress=86, status_text="Archive extracted; preparing files...")
            return

        request = urllib.request.Request(url, headers={"User-Agent": "PolyFix"})
        with urllib.request.urlopen(request, timeout=30) as response:
            total = int(response.headers.get("Content-Length", 0))
            temp.mkdir(parents=True, exist_ok=True)
            archive = temp / "_download.zip"
            downloaded = 0
            started = time.monotonic()
            with archive.open("wb") as output:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    if _task_cancelled(task_id):
                        return
                    output.write(chunk)
                    downloaded += len(chunk)
                    elapsed = max(time.monotonic() - started, 0.001)
                    progress = min(78, int(downloaded / total * 78)) if total else min(78, 78)
                    _update(
                        task_id,
                        progress=progress,
                        speed=int(downloaded / elapsed),
                        downloaded_bytes=downloaded,
                        total_bytes=total,
                        status_text=f"Downloading archive ({format_bytes(downloaded)} / {format_bytes(total) if total else 'unknown size'})...",
                    )
        if _task_cancelled(task_id):
            return
        _update(task_id, progress=80, status_text="Extracting ZIP archive...")
        with zipfile.ZipFile(archive, "r") as zip_file:
            zip_file.extractall(temp)
        archive.unlink(missing_ok=True)
        _update(task_id, progress=86, status_text="Archive extracted; preparing files...")


extension_downloader = ExtensionDownloader()
