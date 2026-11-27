export type PolyFixBackendStatus = {
  state: "starting" | "running" | "stopped" | "error";
  apiBaseUrl: string;
  port: number;
  error?: string;
};

export interface PolyFixDesktopBridge {
  readonly isElectron: true;
  readonly apiBaseUrl: string;
  getBackendStatus: () => Promise<PolyFixBackendStatus>;
  restartBackend: () => Promise<PolyFixBackendStatus>;
  onBackendStatus: (callback: (status: PolyFixBackendStatus) => void) => () => void;
}

declare global {
  interface Window {
    polyfix?: PolyFixDesktopBridge;
  }
}
