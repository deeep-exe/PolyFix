import json
import os
import re
import shutil
import stat
import subprocess
import uuid
from pathlib import Path

from .extensions import EXT_DIR

# Only plain https://github.com/<user>/<repo> links are accepted.
GITHUB_URL = re.compile(
    r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?(?:\.git)?/?$"
)
# Extension ids become folder names, so keep them boring and safe.
SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")


class InstallError(Exception):
    """A problem we can explain to the user in plain English."""


def _unlock_and_retry(func, path, _exc_info):
    # Windows marks files inside .git as read-only. Unlock, then try again.
    os.chmod(path, stat.S_IWRITE)
    func(path)


def _remove_folder(folder: Path):
    shutil.rmtree(folder, onerror=_unlock_and_retry)


def _clone(url: str, dest: Path):
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}  # never wait for a password
    try:
        result = subprocess.run(
            ["git", "clone", "--depth", "1", "--", url, str(dest)],
            capture_output=True,
            text=True,
            timeout=120,
            env=env,
        )
    except FileNotFoundError:
        raise InstallError("Git is not installed (or not on PATH) on this computer.")
    except subprocess.TimeoutExpired:
        raise InstallError("The download took too long. Check your internet.")
    if result.returncode != 0:
        raise InstallError(
            "Could not download that repository. Is the link correct and the repo public?"
        )


def _check_manifest(folder: Path) -> dict:
    manifest_file = folder / "manifest.json"
    if not manifest_file.exists():
        raise InstallError("That repository has no manifest.json in its top folder.")
    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError:
        raise InstallError("manifest.json is not valid JSON.")

    for key in ("id", "name", "entry"):
        if not isinstance(manifest.get(key), str) or not manifest[key]:
            raise InstallError(f'manifest.json is missing "{key}".')
    if not SAFE_ID.match(manifest["id"]):
        raise InstallError("The id may only use lowercase letters, digits and dashes.")

    entry = (folder / manifest["entry"]).resolve()
    if folder.resolve() not in entry.parents or not entry.is_file():
        raise InstallError("The entry file named in manifest.json was not found.")
    return manifest


def install_from_github(url: str) -> dict:
    url = url.strip()
    if not GITHUB_URL.match(url):
        raise InstallError("Please paste a link like https://github.com/user/repo")

    EXT_DIR.mkdir(exist_ok=True)
    temp = EXT_DIR / f".tmp-{uuid.uuid4().hex[:8]}"
    try:
        _clone(url, temp)
        manifest = _check_manifest(temp)

        final = EXT_DIR / manifest["id"]
        if final.exists():
            raise InstallError(f'"{manifest["id"]}" is already installed.')

        _remove_folder(temp / ".git")  # we only need the files, not the history
        temp.rename(final)
        (final / "source.txt").write_text(url, encoding="utf-8")
        return manifest
    finally:
        if temp.exists():  # something went wrong: clean up
            _remove_folder(temp)


def uninstall(ext_id: str):
    if not SAFE_ID.match(ext_id):
        raise InstallError("Invalid extension id.")
    folder = EXT_DIR / ext_id
    # Only extensions that came from a link carry source.txt, so your own
    # hand-made extensions can never be deleted by accident.
    if not (folder / "source.txt").exists():
        raise InstallError("Only extensions installed from a link can be removed.")
    _remove_folder(folder)