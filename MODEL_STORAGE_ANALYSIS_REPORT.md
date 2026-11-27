# PolyFix Model Storage Analysis Report

## 1. Executive Summary

PolyFix currently places downloaded models and extensions under `backend/api/extensions`. The downloader and model manager use `huggingface_hub.snapshot_download(..., local_dir=<temporary extension folder>)`, so these flows avoid the default Hugging Face cache as their final location. However, any library download performed by a generator or preprocessor without an explicit local path/cache setting can still use that process user's cache (normally `%USERPROFILE%\.cache\huggingface\hub` on Windows, or `~/.cache/huggingface/hub` on Unix). No startup configuration sets `HF_HOME`, `HF_HUB_CACHE`, `TORCH_HOME`, or `REMBG_HOME`.

The current workspace has a 6.97 GiB `.tmp-af1a4542` snapshot in `backend/api/extensions` and a 4.56 GiB Shap-E extension directory. The temporary folder is not a discoverable extension (no top-level manifest observed) but occupies disk alongside extensions. Shap-E loads from its own extension directory with `local_files_only=True`, which is portable only while that directory layout and complete weights move together. Imported models are stored as flat extension-id folders and API/UI path fields expose absolute local paths. Extension resolution, install, model import/delete, readiness, and frontend management all assume extensions are immediate children of one `extensions` directory. This couples model storage to code and the machine-specific checkout location and makes centralized categorized storage a coordinated backend/API/UI change.

Scope note: this is a read-only source and working-tree inspection. The repository contains no extension `setup.py` scripts, `.env`/`.env.example`, model-specific cache configuration, or bundled CLI executables in the inspected source tree. The existing `.gitignore` file currently contains literal PowerShell here-string text rather than active ignore rules; the working tree also had pre-existing changes/untracked files during inspection.

## 2. Current Project & Storage Tree

```text
PolyFix/
├── .gitignore                         # currently literal PowerShell here-string text
├── backend/api/
│   ├── .venv/                         # local Python environment; excluded from source inventory
│   ├── app/
│   │   ├── extensions.py              # EXT_DIR = app parent / "extensions"; loads direct child folders
│   │   ├── installer.py               # GitHub clone installation into EXT_DIR/<manifest.id>
│   │   ├── main.py                    # uploads/outputs and API routes
│   │   ├── runs.py                    # run execution wrapper
│   │   ├── routers/                   # API routers
│   │   └── services/
│   │       ├── downloader.py          # GitHub/HF/ZIP installation, temp then EXT_DIR child
│   │       ├── model_manager.py       # HF model import, list, delete under EXT_DIR
│   │       └── dependency_manager.py  # extension requirements/readiness
│   ├── extensions/
│   │   ├── .tmp-af1a4542/             # ~6.97 GiB HF cached snapshot; not a normal extension
│   │   ├── mock-cube/                 # ~2.1 KiB; generator.py, manifest.json, bytecode
│   │   ├── mock-pyramid/              # ~2.2 KiB; generator.py, manifest.json, source.txt, bytecode
│   │   ├── mock-sphere/               # ~2.2 KiB; generator.py, manifest.json, bytecode
│   │   ├── shap-e/                    # ~4.56 GiB; full local model snapshot + generator/docs
│   │   │   ├── prior/                 # config + diffusion weights (.bin and fp16 safetensors)
│   │   │   ├── renderer/              # config + diffusion weights (.bin and fp16 safetensors)
│   │   │   ├── shap_e_renderer/       # config + diffusion .bin
│   │   │   ├── text_encoder/          # config/tokenizer + .bin and fp16 safetensors
│   │   │   ├── tokenizer/             # vocab, merges, tokenizer config
│   │   │   ├── scheduler/             # scheduler config
│   │   │   ├── generator.py, manifest.json, model_index.json, requirements.txt, README.md
│   │   ├── generator.py, manifest.json, mock_glb.py
│   │   └── __pycache__/
│   ├── outputs/                       # generated outputs; currently contains run-id directories
│   ├── uploads/                       # uploaded inputs; currently contains hash-named directories
│   ├── requirements.txt
│   └── requirements-before-phase5.txt
└── web/src/
    ├── api/client.ts                 # extension/model API types and calls
    ├── pages/ModelManagement.tsx     # model import/list/path/size UI
    ├── App.tsx                       # extension metadata and storage_path display
    └── components/                   # install UI and rembg node
```

Disk sizes are recursive file-byte sums observed at inspection time. Shap-E weight files found: `prior/diffusion_pytorch_model.bin` 1,262,937,295 B and fp16 safetensors 631,435,880 B; `renderer/diffusion_pytorch_model.bin` 905,200,536 B and fp16 safetensors 452,597,858 B; `shap_e_renderer/diffusion_pytorch_model.bin` 905,233,202 B; `text_encoder/pytorch_model.bin` 494,664,885 B and fp16 safetensors 247,324,608 B. Duplicate precision variants contribute materially to its footprint. The `.tmp-af1a4542` size is 7,472,123,917 B (about 6.96 GiB). `outputs/` and `uploads/` contain generated/runtime data, not model repositories. No `vendor/`, extension `setup.py`, or CLI binary was found under `backend/api/extensions`.

The `.gitignore` inspection found literal text that resembles a PowerShell here-string (`@" ... "@ | Set-Content ...`) instead of parsed patterns. Thus the apparent intended exclusions (`backend/api/uploads/`, `backend/api/outputs/`, model-weight extensions, `.env`, etc.) may not actually be enforced by Git. No `.env` or `.env.example` was present under `backend/api`.

## 3. Download & Cache Audit Table

| File & Function | Library / Method Used | Current Target / Cache Location | Cross-Device Issue |
|---|---|---|---|
| `backend/api/app/services/downloader.py`, `ExtensionDownloader._run` / `_download_huggingface` | `huggingface_hub.snapshot_download` | Explicit `local_dir` is `backend/api/extensions/.tmp-<id>`, then renamed to `extensions/<manifest id>`; no `cache_dir` | Final location is checkout-relative but absolute paths are derived at runtime. HF library may still use its own metadata/cache behavior; no cache environment is configured. Failed/cancelled temp cleanup exists, but interrupted process can leave temp folders. |
| `backend/api/app/services/downloader.py`, `_download_github` | `git clone --depth 1` subprocess | `backend/api/extensions/.tmp-<id>`, then renamed to extension id | Requires Git installed/on PATH; content stored alongside model data. |
| `backend/api/app/services/downloader.py`, `_download_zip` | `urllib.request.urlopen`, `zipfile` | Streams ZIP into `backend/api/extensions/.tmp-<id>/_download.zip`, extracts locally | Depends on URL/network or source path; same extension-folder coupling. |
| `backend/api/app/installer.py`, `_clone` / `install_from_github` | `git clone --depth 1` subprocess | `backend/api/extensions/.tmp-<id>`, then `extensions/<id>` | Requires system Git and writes code and any bundled weights together. |
| `backend/api/app/services/model_manager.py`, model import worker (around lines 245-262) | `huggingface_hub.snapshot_download` | Explicit `local_dir` to temp under `EXT_DIR`, then renamed to `EXT_DIR/<model id>`; no `cache_dir` | Same centralized-storage limitation; the directory doubles as installed extension and model registry. |
| `backend/api/extensions/shap-e/generator.py`, `generate` | Diffusers `from_pretrained` | Local `model_dir = Path(__file__).resolve().parent`, `local_files_only=True` | Offline after files are present, but expects a full diffusers-compatible repo layout colocated with generator; moving weights separately breaks it. |
| `backend/api/app/services/doc_parser.py`, README fetch | `urllib.request.urlopen` | Network fetch into memory; not a model/weight download | Requires network for remote docs; no persistent model cache. |
| `rembg` dependency/runtime (referenced by `web/src/components/nodes/RembgNode.tsx`, backend requirements and extension requirements) | Library-managed pretrained segmentation model; no project call site explicitly sets its model path | No `REMBG_HOME` assignment found; defaults to library/user cache behavior unless configured elsewhere | Can download into per-user cache on first run, independently of PolyFix extension storage. No backend remove-bg route implementation was found in current Python files despite UI request path. |
| Other searched mechanisms | No `torch.hub` call, no `hf_hub_download`, and no extension `setup.py` download script found | N/A | Any transitive library behavior is outside explicit project call sites. |

## 4. Model & Extension Type Inventory

Manifest fields observed across local extension manifests are `id`, `name`, `version`, `type`, `entry`; Shap-E additionally has `requires_gpu` and `source_url`. Runtime import may add/default `description`, `requires_gpu`, and `source_url`. Frontend API types also allow `is_ready`, `status_message`, `removable`, `storage_path`, `folder_name`, `source_url`, and `parameters`, but these are not present in the four checked-in extension manifests. `inputs` and `outputs` are not present in the current manifests.

| Extension / Asset | Category / Modality | Current manifest structure | Weight / asset loading method |
|---|---|---|---|
| `shap-e` | 3D generative model; Image-to-3D path is attempted, with text-to-3D fallback | `id`, `name`, `version`, `type=model`, `entry`, `requires_gpu=true`, `source_url` | Loads local extension folder with Diffusers `from_pretrained(..., local_files_only=True)`; weight files reside beneath `prior/`, `renderer/`, `shap_e_renderer/`, `text_encoder/`. |
| `mock-cube` | Mock/demo 3D generator | `id`, `name`, `version`, `type=model`, `entry` | No learned weights; Python generator implementation. |
| `mock-pyramid` | Mock/demo 3D generator | Same as mock-cube | No learned weights; Python generator implementation and `source.txt`. |
| `mock-sphere` | Mock/demo 3D generator | Same as mock-cube | No learned weights; Python generator implementation. |
| `rembg` | Auxiliary image background-removal preprocessor | Not a discovered extension manifest; Python requirement and frontend workflow node refer to it | No explicit project model path; library-managed weight download/cache likely. `REMBG_HOME` not configured. |
| Instant Meshes / Blender / Khronos glTF Validator | External CLI/binary assets | No manifest or executable found in repository scan | No current project-managed download or resolution path found. |
| `.tmp-af1a4542` HF snapshot | Unfinished/cache residue, not classified as installed extension | No top-level manifest observed | Files exist directly under a dot-prefixed temporary folder, about 6.96 GiB; likely retained download/import data, exact originating call cannot be proven from folder alone. |

No current Image/Mesh-to-Mesh extension, extension `setup.py`, `vendor/` folder, or CLI binary was found in `backend/api` source inventory.

## 5. Hardcoded Paths & Environment Variable Gaps

Line references below are repository-relative and refer to the inspected current files:

- `backend/api/app/extensions.py:6` — `EXT_DIR = Path(__file__).resolve().parent.parent / "extensions"`; all extension/model storage roots are anchored to checkout structure.
- `backend/api/app/services/downloader.py:194-195, 214` — creates temporary download folder and final extension folder under `EXT_DIR`.
- `backend/api/app/services/downloader.py:299-303` — HF snapshot uses explicit `local_dir`, but no `cache_dir` or cache environment override.
- `backend/api/app/services/model_manager.py:200, 235-239, 253-264` — import target/temp and snapshot `local_dir` use `EXT_DIR`; no `cache_dir`.
- `backend/api/app/installer.py:80-86` — GitHub extension temp/final paths use `EXT_DIR`.
- `backend/api/extensions/shap-e/generator.py:16, 34-35, 43-54` — derives local model path from generator location and loads offline; no configurable model root.
- `backend/api/app/main.py:16-17` — uploads/output roots derive from API directory; not model paths, but runtime assets are similarly checkout-relative.
- `web/src/api/client.ts:1` and `web/src/components/nodes/RembgNode.tsx:30` — default API URL uses `http://localhost:8000`; machine-local service assumption, not model storage.
- Search across `backend/api` and `web/src` found no assignments or reads of `HF_HOME`, `HF_HUB_CACHE`, `TORCH_HOME`, or `REMBG_HOME`; no explicit drive-letter absolute model path was found in project source. Windows per-user cache path is an inferred library default, not a literal present in source.
- `backend/api/extensions/shap-e/README.md:49` contains an upstream example calling `ShapEPipeline.from_pretrained(repo).to("cuda")`; this is documentation, not the runtime generator's loading path.
- `backend/api/extensions/manifest.json` exists as a registry-like root manifest but it only describes `mock-cube`; actual loaded extension discovery scans child directories. No `.env` file was found; `.gitignore` currently has no effective configuration confirmed due to its literal text content.

## 6. Impacted Files Checklist

Files to review/update for a centralized, categorized `models/` root (exact changes depend on chosen schema and backward-compatibility plan):

- **Storage root and extension discovery:** `backend/api/app/extensions.py`; all code in `backend/api/app/extensions.py` that scans `EXT_DIR` child folders; root `backend/api/extensions/manifest.json` if it is intended as registry metadata.
- **Download/install paths:** `backend/api/app/services/downloader.py`, `backend/api/app/services/model_manager.py`, `backend/api/app/installer.py`.
- **Path resolution and execution:** `backend/api/extensions/shap-e/generator.py`, `backend/api/app/runs.py`, and extension generator entry points as future models are added. `backend/api/app/services/dependency_manager.py` and `backend/api/app/extensions.py` also resolve manifests/entries under the current flat root.
- **API surfaces and serializers:** `backend/api/app/main.py`, `backend/api/app/services/model_manager.py`, `backend/api/app/extensions.py`, and router files under `backend/api/app/routers/` that expose installs, downloads, models, paths, or extension details.
- **Preprocessor cache configuration:** startup/configuration and dependency/runtime integration for rembg; currently no explicit `REMBG_HOME` or project-managed asset path exists.
- **Configuration and ignore rules:** root `.gitignore` (currently malformed as literal script text); add/adjust `.env.example` or equivalent configuration if the centralized root is configurable. `backend/api/requirements.txt` and extension `requirements.txt` may need alignment if dependencies/tools are changed.
- **Frontend contract and displays:** `web/src/api/client.ts` (`storage_path`, `folder_name`, `local_path` and model types); `web/src/pages/ModelManagement.tsx` (model path display/import/delete); `web/src/App.tsx` (extension `storage_path` rendering and install/model UI); `web/src/components/InstallExtension.tsx`; `web/src/hooks/useDownloads.ts`; `web/src/components/DependencyPromptModal.tsx` and `web/src/components/ExtensionDocPanel.tsx` where extension metadata is consumed.
- **Optional new management or category UI:** `web/src/pages/ModelManagement.tsx` and navigation/sidebar code in `web/src/App.tsx` if categories become user-visible.
- **No current setup scripts or binary manifests:** there are no `extensions/*/setup.py` files or repository-managed Blender/Instant Meshes/glTF Validator binaries to update in the inspected tree.
