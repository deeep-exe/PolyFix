const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export type BackendConnectionState = "checking" | "connected" | "disconnected" | "error";

export type ParameterValue = string | number | boolean;
export type ExtensionParameterOption = string | number | { label?: string; value: string | number };
export type ExtensionParameter = {
  type: "number" | "string" | "boolean" | "select";
  label?: string;
  default?: ParameterValue;
  min?: number;
  max?: number;
  step?: number;
  options?: ExtensionParameterOption[];
};

export type ExtensionManifest = {
  id: string;
  name: string;
  version: string;
  type: string;
  entry?: string;
  description?: string;
  requires_gpu?: boolean;
  is_ready: boolean;
  status_message: string;
  removable?: boolean;
  storage_path?: string;
  folder_name?: string;
  source_url?: string;
  parameters?: Record<string, ExtensionParameter>;
};

export type RunState = {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  error?: string | null;
};

async function responseError(response: Response): Promise<Error> {
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const body: unknown = await response.json();
    if (typeof body === "string" && body.trim()) message = body;
    else if (body && typeof body === "object") {
      const details = body as { detail?: unknown; message?: unknown; error?: unknown };
      const detail = details.detail ?? details.message ?? details.error;
      if (typeof detail === "string" && detail.trim()) message = detail;
      else if (detail !== undefined) message = JSON.stringify(detail);
    }
  } catch {
    // Keep the HTTP status message when the body is empty, malformed, or not JSON.
  }
  return new Error(message);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw await responseError(response);
  try {
    return await response.json() as T;
  } catch {
    throw new Error("The backend returned an invalid JSON response.");
  }
}

export async function checkBackendConnection(): Promise<BackendConnectionState> {
  try {
    const health = await fetch(`${BASE}/health`);
    if (health.ok) return "connected";
  } catch {
    // Try the root endpoint for backends that expose health there instead.
  }

  try {
    const extensions = await fetch(`${BASE}/extensions`);
    if (extensions.ok) return "connected";
  } catch {
    // Fall through to the root connectivity probe.
  }

  try {
    const root = await fetch(BASE);
    return root.ok ? "connected" : "disconnected";
  } catch {
    return "error";
  }
}

export function createRun(extensionId: string, imageFile: File, params: Record<string, ParameterValue>) {
  const form = new FormData();
  form.append("extension_id", extensionId);
  form.append("image", imageFile);
  form.append("params", JSON.stringify(params));

  return fetchJson<{ id: string; status: string }>(`${BASE}/runs`, {
    method: "POST",
    body: form,
  });
}

export const getRun = (id: string) => fetchJson<RunState>(`${BASE}/runs/${id}`);
export const getRunStatus = getRun;

export async function cancelRun(id: string): Promise<void> {
  const response = await fetch(`${BASE}/runs/${id}`, { method: "DELETE" });
  if (!response.ok) throw await responseError(response);
}

export const resultUrl = (id: string) => `${BASE}/runs/${id}/result`;

export function getExtensions() {
  return fetchJson<ExtensionManifest[]>(`${BASE}/extensions`);
}

export type ExtensionDocs = {
  extension_id: string;
  source_url?: string;
  raw_markdown: string;
  summary: string;
  recommended_params: Record<string, ParameterValue>;
  vram_requirement: string;
};

export function fetchExtensionDocs(extensionId: string) {
  return fetchJson<ExtensionDocs>(
    `${BASE}/extensions/${encodeURIComponent(extensionId)}/docs`,
  );
}

export type ExtensionDependencyAudit = {
  extension_id: string;
  missing_packages: string[];
  cuda_available: boolean;
  is_ready: boolean;
  error?: string;
  install_status?: "completed" | "failed" | "no_requirements";
  install_error?: string;
};

export function checkExtensionDeps(id: string) {
  return fetchJson<ExtensionDependencyAudit>(
    `${BASE}/extensions/${encodeURIComponent(id)}/deps`,
  );
}

export type NodePreflightResult = {
  extension_id: string;
  ready: boolean;
  dependencies: ExtensionDependencyAudit;
  signature: {
    valid: boolean;
    expected_params: string[];
    accepts_var_kwargs: boolean;
    message: string;
  };
};

export function checkNodePreflight(id: string) {
  return fetchJson<NodePreflightResult>(
    `${BASE}/extensions/${encodeURIComponent(id)}/preflight`,
  );
}

export function installExtensionDeps(id: string) {
  return fetchJson<ExtensionDependencyAudit>(
    `${BASE}/extensions/${encodeURIComponent(id)}/install-deps`,
    { method: "POST" },
  );
}

export type ModelTaskStatus = {
  task_id: string;
  model_id: string;
  status: "downloading" | "completed" | "failed";
  progress: number;
  error: string | null;
  eta?: string | null;
};

export type ManagedModel = {
  id: string;
  name: string;
  version: string;
  type: string;
  source_url?: string;
  local_path: string;
  storage_category: string;
  removable: boolean;
  size_bytes: number;
  installed: boolean;
  cuda_ready: boolean;
  status: string;
  requires_gpu: boolean;
};

export function importHuggingFaceModel(hf_url: string) {
  return fetchJson<{ task_id: string; status: string; model_id: string }>(
    `${BASE}/models/import`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hf_url }),
    },
  );
}

export const getModelStatus = (taskId: string) =>
  fetchJson<ModelTaskStatus>(`${BASE}/models/status/${taskId}`);

export const getModels = () =>
  fetchJson<ManagedModel[]>(`${BASE}/models`);

export async function deleteModel(modelId: string): Promise<void> {
  const response = await fetch(`${BASE}/models/${encodeURIComponent(modelId)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await responseError(response);
}

export async function removeExtension(extensionId: string): Promise<void> {
  const response = await fetch(`${BASE}/extensions/${encodeURIComponent(extensionId)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await responseError(response);
}

export const deleteExtension = removeExtension;

export type ExtensionDownloadTask = {
  task_id: string;
  url: string;
  source_type: "github" | "huggingface" | "zip";
  name: string;
  progress: number;
  speed: number;
  downloaded_bytes: number;
  total_bytes: number;
  status: "downloading" | "completed" | "failed" | "cancelled";
  status_text: string;
  error: string | null;
};

export function installExtension(url: string) {
  return fetchJson<{ task_id: string; status: string }>(`${BASE}/extensions/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export const getDownloadTasks = () =>
  fetchJson<ExtensionDownloadTask[]>(`${BASE}/extensions/downloads`);

export async function installExtensionZip(file: File) {
  const form = new FormData();
  form.append("file", file);
  return fetchJson<{ task_id: string; status: string }>(
    `${BASE}/extensions/install/upload`,
    { method: "POST", body: form },
  );
}

export async function cancelDownloadTask(taskId: string): Promise<void> {
  const response = await fetch(`${BASE}/extensions/downloads/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await responseError(response);
}
