import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from ..storage import iter_model_folders


API_ROOT = Path(__file__).resolve().parents[2]


def _manifest_for_extension(extension_id: str) -> tuple[dict[str, Any], Path | None]:
    search_roots = [
        API_ROOT / "extensions",
        *(folder.parent for folder in iter_model_folders()),
        API_ROOT / "vendor",
        API_ROOT.parent / "vendor",
        API_ROOT.parent.parent / "vendor",
    ]

    exact_folder = next(
        (root / extension_id for root in search_roots if (root / extension_id / "manifest.json").is_file()),
        None,
    )
    if exact_folder is not None:
        manifest_path = exact_folder / "manifest.json"
        return json.loads(manifest_path.read_text(encoding="utf-8-sig")), exact_folder

    for root in search_roots:
        if not root.is_dir():
            continue
        for manifest_path in root.glob("*/manifest.json"):
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
            except (json.JSONDecodeError, OSError):
                continue
            if manifest.get("id") == extension_id:
                return manifest, manifest_path.parent

    for folder in iter_model_folders():
        manifest_path = folder / "manifest.json"
        if not manifest_path.is_file():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, OSError):
            continue
        if manifest.get("id") == extension_id:
            return manifest, folder
    return {}, None


def _read_local_readme(extension_id: str, extension_folder: Path | None) -> str | None:
    candidates: list[Path] = []
    if extension_folder is not None:
        candidates.append(extension_folder / "README.md")
    candidates.extend([
        *(folder / "README.md" for folder in iter_model_folders() if folder.name == extension_id),
        API_ROOT / "extensions" / extension_id / "README.md",
        API_ROOT / "vendor" / "*",
        API_ROOT.parent / "vendor" / "*",
        API_ROOT.parent.parent / "vendor" / "*",
    ])

    for candidate in candidates:
        if "*" in str(candidate):
            for folder in candidate.parent.glob("*"):
                readme = folder / "README.md"
                if readme.is_file():
                    try:
                        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8-sig")) if (folder / "manifest.json").is_file() else {}
                        if manifest.get("id") == extension_id:
                            return readme.read_text(encoding="utf-8-sig")
                    except (json.JSONDecodeError, OSError):
                        pass
            continue
        if candidate.is_file():
            return candidate.read_text(encoding="utf-8-sig")
    return None


def _github_raw_url(source_url: str) -> str | None:
    match = re.match(r"https?://(?:www\.)?github\.com/([^/\s]+)/([^/\s#]+)", source_url.strip(), re.I)
    if not match:
        return None
    org, repo = match.groups()
    repo = repo.removesuffix(".git")
    return f"https://raw.githubusercontent.com/{org}/{repo}/main/README.md"


def _huggingface_raw_url(source_url: str) -> str | None:
    match = re.search(r"https?://(?:www\.)?huggingface\.co/([^/\s]+)/([^/\s#]+)", source_url.strip(), re.I)
    if not match:
        return None
    owner, repo = match.groups()
    return f"https://huggingface.co/{owner}/{repo}/raw/main/README.md"


def _fetch_url(url: str) -> str | None:
    request = urllib.request.Request(url, headers={"User-Agent": "PolyFix-Documentation-Reader/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            if response.status >= 400:
                return None
            return response.read().decode("utf-8-sig", errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError):
        return None


def fetch_extension_readme(extension_id: str) -> dict:
    manifest, extension_folder = _manifest_for_extension(extension_id)
    raw = _read_local_readme(extension_id, extension_folder)
    source_url = str(manifest.get("source_url", "") or "")

    if raw is None and "huggingface.co" in source_url.lower():
        raw_url = _huggingface_raw_url(source_url)
        if raw_url:
            raw = _fetch_url(raw_url)

    if raw is None and "github.com" in source_url.lower():
        raw_url = _github_raw_url(source_url)
        if raw_url:
            raw = _fetch_url(raw_url)

    raw = raw or ""
    return {
        "extension_id": extension_id,
        "source_url": source_url,
        **parse_readme_metadata(raw),
    }


def _human_summary(markdown: str) -> str:
    text = re.sub(r"\A---\n.*?\n---\n", "", markdown, count=1, flags=re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"^[#*`>\-\s]+", "", text, flags=re.M)
    paragraphs = re.split(r"\n\s*\n", text.strip())
    for paragraph in paragraphs:
        cleaned = " ".join(line.strip() for line in paragraph.splitlines()).strip()
        if cleaned and len(cleaned) > 20:
            return cleaned[:500]
    return "No documentation summary is available."


def _parse_param_value(value: str) -> int | float | bool | str | None:
    value = value.strip().strip("\"'`,;")
    if re.fullmatch(r"[-+]?\d+", value):
        return int(value)
    if re.fullmatch(r"[-+]?(?:\d+\.\d*|\.\d+)", value):
        return float(value)
    lowered = value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if value:
        return value
    return None


def parse_readme_metadata(raw_markdown: str) -> dict:
    recommended_params: dict[str, Any] = {}
    param_names = (
        "octree_resolution", "guidance_scale", "num_inference_steps",
        "inference_steps", "num_steps", "steps", "size", "seed",
        "resolution", "batch_size", "cfg_scale", "guidance",
    )

    for name in param_names:
        patterns = [
            rf"\b{name}\s*(?:=|:)\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)|[\"'][^\"']+[\"'])",
            rf"(?im)^\|?\s*{re.escape(name)}\s*\|?\s*:?\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))",
        ]
        for pattern in patterns:
            match = re.search(pattern, raw_markdown)
            if match:
                value = _parse_param_value(match.group(1))
                if value is not None:
                    recommended_params[name] = value
                break

    vram_requirement = ""
    hardware_lines = [
        line.strip() for line in raw_markdown.splitlines()
        if re.search(r"\b(?:VRAM|CUDA|GPU|GB)\b", line, re.I)
    ]
    if hardware_lines:
        preferred = next(
            (line for line in hardware_lines if re.search(r"\b(?:VRAM|GB)\b", line, re.I)),
            hardware_lines[0],
        )
        vram_requirement = re.sub(r"[*_`]", "", preferred)[:300]

    return {
        "raw_markdown": raw_markdown,
        "summary": _human_summary(raw_markdown) if raw_markdown else "Documentation was not found for this extension.",
        "recommended_params": recommended_params,
        "vram_requirement": vram_requirement,
    }
