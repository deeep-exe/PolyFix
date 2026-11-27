import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

export type BackendState = "starting" | "running" | "stopped" | "error";

export interface BackendStatus {
  state: BackendState;
  apiBaseUrl: string;
  port: number;
  error?: string;
}

const DEFAULT_PORT = 8000;
const HEALTH_POLL_INTERVAL_MS = 300;
const HEALTH_TIMEOUT_MS = 20000;

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate an ephemeral port.")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function selectPort(): Promise<number> {
  if (await isPortAvailable(DEFAULT_PORT)) {
    return DEFAULT_PORT;
  }
  return getEphemeralPort();
}

function checkHealth(apiBaseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${apiBaseUrl}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function resolveBackendDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "backend", "api");
  }
  return path.resolve(__dirname, "..", "..", "backend", "api");
}

function resolvePythonExecutable(backendDir: string): string {
  const candidates =
    process.platform === "win32"
      ? [
          path.join(backendDir, ".venv", "Scripts", "python.exe"),
          "python",
        ]
      : [
          path.join(backendDir, ".venv", "bin", "python"),
          "python3",
          "python",
        ];

  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

export class BackendManager {
  private process: ChildProcess | null = null;
  private status: BackendStatus = {
    state: "stopped",
    apiBaseUrl: `http://127.0.0.1:${DEFAULT_PORT}`,
    port: DEFAULT_PORT,
  };
  private onStatusChange?: (status: BackendStatus) => void;
  private stopping = false;

  constructor(onStatusChange?: (status: BackendStatus) => void) {
    this.onStatusChange = onStatusChange;
  }

  getStatus(): BackendStatus {
    return { ...this.status };
  }

  private setStatus(next: BackendStatus) {
    this.status = next;
    this.onStatusChange?.(this.getStatus());
  }

  async start(): Promise<BackendStatus> {
    if (this.process && (this.status.state === "running" || this.status.state === "starting")) {
      return this.getStatus();
    }

    this.stopping = false;
    const backendDir = resolveBackendDir();
    if (!fs.existsSync(backendDir)) {
      const error = `Backend directory not found: ${backendDir}`;
      this.setStatus({ ...this.status, state: "error", error });
      return this.getStatus();
    }

    const port = await selectPort();
    const apiBaseUrl = `http://127.0.0.1:${port}`;
    const pythonExe = resolvePythonExecutable(backendDir);

    this.setStatus({ state: "starting", apiBaseUrl, port });

    const child = spawn(
      pythonExe,
      ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)],
      {
        cwd: backendDir,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    this.process = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(`[backend] ${chunk.toString()}`);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[backend] ${chunk.toString()}`);
    });

    child.on("error", (err) => {
      if (this.process === child) {
        this.process = null;
      }
      this.setStatus({
        state: "error",
        apiBaseUrl,
        port,
        error: `Failed to start backend: ${err.message}`,
      });
    });

    child.on("exit", (code, signal) => {
      if (this.process === child) {
        this.process = null;
      }
      if (this.stopping) {
        this.setStatus({ state: "stopped", apiBaseUrl, port });
        return;
      }
      this.setStatus({
        state: "error",
        apiBaseUrl,
        port,
        error: `Backend exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
      });
    });

    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.process !== child || this.status.state === "error") {
        return this.getStatus();
      }
      if (await checkHealth(apiBaseUrl)) {
        this.setStatus({ state: "running", apiBaseUrl, port });
        return this.getStatus();
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
    }

    if (this.status.state === "starting") {
      this.setStatus({
        state: "error",
        apiBaseUrl,
        port,
        error: "Timed out waiting for backend /health endpoint.",
      });
    }
    return this.getStatus();
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child || !child.pid) {
      this.status = { ...this.status, state: "stopped" };
      return;
    }

    this.stopping = true;
    const pid = child.pid;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.on("exit", () => resolve());
          killer.on("error", () => resolve());
        } else {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process already exited.
          }
          resolve();
        }
      }, 3000);

      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => {
          try {
            child.kill();
          } catch {
            // Ignore if already exited.
          }
        });
      } else {
        child.kill("SIGTERM");
      }
    });

    this.process = null;
    this.setStatus({ ...this.status, state: "stopped" });
  }

  async restart(): Promise<BackendStatus> {
    await this.stop();
    return this.start();
  }
}
