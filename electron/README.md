# PolyFix Electron Desktop App

This directory contains the Electron desktop wrapper for PolyFix. It uses the React/Vite app in [../web](../web) as its entire frontend and automatically starts, monitors, and stops the FastAPI backend in [../backend/api](../backend/api).

## Prerequisites

- **Node.js** v18+ and **npm**
- **Python backend** set up in `../backend/api/.venv` (the app uses `../backend/api/.venv/Scripts/python.exe` on Windows, falling back to system `python` if `.venv` is absent)

## How to Start

From `D:\code\PolyFix\electron`:

### 1. Install dependencies (first time only)

```bash
npm install
```

### 2. Run the built desktop app

Build the React frontend and Electron main/preload scripts, then launch Electron:

```bash
npm run build
npm start
```

> Run `npm run build` again whenever you change files in `web/` or `electron/src/`.

### 3. Run in development mode (live reload)

Starts the Vite dev server (`http://localhost:5173`), waits for it to be ready, and launches Electron (which starts the FastAPI backend automatically):

```bash
npm run dev
```

## How It Works

- On startup, Electron selects port `8000` (or an available ephemeral port if `8000` is already in use) and spawns:
  ```text
  python -m uvicorn app.main:app --host 127.0.0.1 --port <port>
  ```
- Electron polls `GET /health` until the backend is ready, passes the active backend URL to the React frontend via `window.polyfix.apiBaseUrl`, and terminates the backend process tree when you close the app.
