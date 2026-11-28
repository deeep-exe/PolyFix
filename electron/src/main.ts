import { app, BrowserWindow, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { BackendManager, type BackendStatus } from "./backend";

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

app.setName("PolyFix");
if (process.platform === "win32") {
  // Gives the taskbar entry its own identity, so Windows uses the window icon
  // (box.png) rather than grouping it under electron.exe's icon.
  app.setAppUserModelId("com.polyfix.studio");
}

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

const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, "renderer", "box.png")
  : path.resolve(__dirname, "..", "..", "web", "public", "box.png");

// Shown straight away while the Python backend boots, so the taskbar shows the
// PolyFix box instead of the stock Electron icon during startup.
function createSplashWindow(): BrowserWindow {
  let logo = "";
  try {
    logo = `data:image/png;base64,${fs.readFileSync(iconPath).toString("base64")}`;
  } catch {
    // No logo file: the splash still shows the name.
  }
  const splash = new BrowserWindow({
    width: 360,
    height: 260,
    frame: false,
    resizable: false,
    movable: true,
    center: true,
    title: "PolyFix",
    icon: iconPath,
    backgroundColor: "#101113",
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>PolyFix</title><style>
    html,body{margin:0;height:100%;background:#101113;color:#E8E6E3;font-family:Segoe UI,system-ui,sans-serif;-webkit-app-region:drag;user-select:none}
    body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
    img{width:88px;height:88px;object-fit:contain}
    strong{font-size:20px;letter-spacing:.02em}
    span{color:#8F9399;font-size:12px}
    i{width:140px;height:3px;border-radius:3px;background:#2A2C31;overflow:hidden;position:relative}
    i:after{content:"";position:absolute;inset:0;width:40%;background:#FF6D1F;animation:s 1.2s ease-in-out infinite}
    @keyframes s{0%{left:-40%}100%{left:100%}}
  </style></head><body>
    ${logo ? `<img src="${logo}" alt="">` : ""}
    <strong>PolyFix</strong><span>Starting model studio…</span><i></i>
  </body></html>`;
  void splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return splash;
}

async function createMainWindow(apiBaseUrl: string, splash?: BrowserWindow): Promise<void> {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    title: "PolyFix",
    icon: iconPath,
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
    if (splash && !splash.isDestroyed()) splash.close();
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
  const splash = createSplashWindow();
  try {
    const status = await backend.start();
    await createMainWindow(status.apiBaseUrl, splash);
  } catch (error) {
    if (!splash.isDestroyed()) splash.close();
    throw error;
  }

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
