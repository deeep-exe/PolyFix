# Local model storage

PolyFix stores runtime model assets and library caches below this directory so the complete `models/` tree can travel with the repository checkout.

- `image-to-3d/`, `text-to-3d/`, and `mesh-repair/` hold model repositories by task.
- `preprocessors/` holds preprocessor weights such as rembg/U2Net.
- `bin/` holds external command-line tools.
- `.cache/` holds Hugging Face and Torch caches and is intentionally excluded from version control.

Set `POLYFIX_MODELS_DIR` only if a non-default storage root is needed. Library cache variables are configured from the resolved model root before model libraries are imported.
