import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { BackendManager, type BackendStatus } from "./backend";

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

const backend = new BackendManager((status: BackendStatus) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("polyfix:backend-status-changed", status);
  }
});

function resolveRendererEntry(): { type: "url" | "file"; target: string } {
  if (process.env.ELECTRON_DEV === "1") {
    return { type: "url", target: "http://localhost:5173" };
  }
  if (app.isPackaged) {
    return {
      type: "file",
      target: path.join(process.resourcesPath, "renderer", "index.html"),
    };
  }
  return {
    type: "file",
    target: path.resolve(__dirname, "..", "..", "web", "dist", "index.html"),
  };
}

async function createMainWindow(apiBaseUrl: string): Promise<void> {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    title: "PolyFix",
    backgroundColor: "#0f1115",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--polyfix-api-url=${apiBaseUrl}`],
    },
  });

  mainWindow = win;

  win.once("ready-to-show", () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  const entry = resolveRendererEntry();
  if (entry.type === "url") {
    await win.loadURL(entry.target);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    await win.loadFile(entry.target);
  }

  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });
}

ipcMain.handle("polyfix:backend-status", () => backend.getStatus());
ipcMain.handle("polyfix:backend-restart", () => backend.restart());

app.whenReady().then(async () => {
  const status = await backend.start();
  await createMainWindow(status.apiBaseUrl);

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow(backend.getStatus().apiBaseUrl);
    }
  });
});

app.on("before-quit", (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  void backend.stop().finally(() => {
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
