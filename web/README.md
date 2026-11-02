# PolyFix Frontend

PolyFix is an interface for orchestrating 3D asset generation and post-processing workflows. The frontend lets you select an installed model or repair extension, provide a source image, monitor a run, preview the resulting 3D asset, and download the output. Extensions can also be installed from a Git URL or supported archive.

This repository contains the React, TypeScript, and Vite web client. It relies on a separate PolyFix FastAPI backend for extension discovery and installation, job execution, status updates, and generated files.

## Prerequisites

- Node.js v18 or newer
- npm (included with Node.js) or pnpm
- A running PolyFix FastAPI backend reachable from the browser

## Quickstart

From this directory, install dependencies:

```bash
npm install
```

Start the Vite development server:

```bash
npm run dev
```

Open the local URL printed by Vite. Ensure the backend is running and that its URL is configured as described below.

Create and preview a production build:

```bash
npm run build
npm run preview
```

`npm run build` runs the TypeScript project build and creates production assets in `dist/`. `npm run preview` serves those built assets locally for a production-style check.

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `VITE_API_URL` | Base URL of the PolyFix FastAPI backend, without a trailing slash. The frontend uses it for API requests and generated result URLs. | `http://localhost:8000` |

For local development, create a `.env.local` file in the project root if the backend uses a different address:

```dotenv
VITE_API_URL=http://localhost:8000
```

Vite exposes `VITE_` variables in the browser bundle. Do not put secrets in this variable or in other `VITE_` variables.

## Expected Backend Endpoints

The frontend and backend must be configured to reach each other from the user's browser. The backend should enable CORS for the frontend's origin when they are served from different origins.

| Method and path | Purpose | Frontend expectations |
| --- | --- | --- |
| `GET /health` or `GET /` | Backend health check | Should return a successful response when the service is ready. |
| `GET /extensions` | List available model-generation and repair extensions | Returns a JSON array of extension manifests. The UI uses fields such as `id`, `name`, `version`, `type`, and optional `requires_gpu`, `description`, and `parameters`. |
| `POST /runs` | Submit a generation or post-processing run | Multipart form data containing `image` (the uploaded file), `extension_id` (the selected extension ID), and `params` (extension parameters, when supported). Returns a run identifier and initial status. |
| `GET /runs/{id}` | Get run status and progress | Returns the run ID, a status such as `queued`, `running`, `done`, `failed`, or `cancelled`, progress, and an optional error. The frontend polls this endpoint while a run is active. |
| `POST /extensions/install` | Install an extension from a Git URL or supported archive | Accepts JSON with a `url` field and returns installation information, including the installed extension name on success. |

The current client also uses `DELETE /runs/{id}` to cancel a run and `GET /runs/{id}/result` to retrieve its generated GLB output. Implement these routes in the backend if cancellation and result viewing/downloading are needed.

## Supported Image Specifications

- Formats: PNG, JPEG (`.jpg` or `.jpeg`), and WEBP
- Maximum file size: 10 MB

The backend should validate file type and size as well; client-side checks alone are not a security or resource limit.

## Extension Installation Format

An extension can be supplied as a Git URL or as a supported `.zip` archive. The extension source must contain a `manifest.json` at its root. The manifest describes the extension so PolyFix can identify and present it to the frontend. At minimum, include an extension ID, name, version, and type. Optional metadata may include a description, whether a GPU is required, and a `parameters` definition for configurable inputs.

Example layout:

```text
my-extension/
├── manifest.json
└── ... extension implementation files ...
```

For a ZIP upload/source, `manifest.json` should be at the archive root rather than nested inside an extra containing directory. A Git URL should resolve to a repository whose root contains the manifest. The backend is responsible for validating, installing, and loading the extension implementation.
