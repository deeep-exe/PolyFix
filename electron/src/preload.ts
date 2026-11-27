import { contextBridge, ipcRenderer } from "electron";

export type BackendStatus = {
  state: "starting" | "running" | "stopped" | "error";
  apiBaseUrl: string;
  port: number;
  error?: string;
};

const apiUrlArg = process.argv.find((arg) => arg.startsWith("--polyfix-api-url="));
const apiBaseUrl = apiUrlArg
  ? apiUrlArg.slice("--polyfix-api-url=".length)
  : "http://127.0.0.1:8000";

contextBridge.exposeInMainWorld("polyfix", {
  isElectron: true as const,
  apiBaseUrl,
  getBackendStatus: (): Promise<BackendStatus> => ipcRenderer.invoke("polyfix:backend-status"),
  restartBackend: (): Promise<BackendStatus> => ipcRenderer.invoke("polyfix:backend-restart"),
  onBackendStatus: (callback: (status: BackendStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: BackendStatus) => {
      callback(status);
    };
    ipcRenderer.on("polyfix:backend-status-changed", listener);
    return () => {
      ipcRenderer.removeListener("polyfix:backend-status-changed", listener);
    };
  },
});
