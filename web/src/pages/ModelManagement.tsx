import { useEffect, useMemo, useState } from "react";
import {
  deleteModel,
  getModelStatus,
  getModels,
  importHuggingFaceModel,
  type ManagedModel,
  type ModelTaskStatus,
} from "../api/client";

type Props = {
  onModelsChanged: () => void;
};

const HF_PATTERN =
  /^(?:(?:https?:\/\/(?:www\.)?huggingface\.co\/)?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)(?:\/.*)?\/?$/i;

function formatBytes(bytes: number) {
  if (!bytes) return "0 MB";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function ModelManagement({ onModelsChanged }: Props) {
  const [models, setModels] = useState<ManagedModel[]>([]);
  const [hfUrl, setHfUrl] = useState("");
  const [error, setError] = useState("");
  const [task, setTask] = useState<ModelTaskStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const loadModels = async () => {
    try {
      const list = await getModels();
      setModels(list);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load models.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadModels();
  }, []);

  useEffect(() => {
    if (!task || task.status !== "downloading") return;
    const timer = window.setInterval(async () => {
      try {
        const status = await getModelStatus(task.task_id);
        setTask(status);
        if (status.status !== "downloading") {
          window.clearInterval(timer);
          if (status.status === "completed") {
            void loadModels();
            onModelsChanged();
          }
        }
      } catch (e) {
        setTask((current) => current ? {
          ...current,
          status: "failed",
          error: e instanceof Error ? e.message : "Could not read download status.",
        } : current);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [task?.task_id, task?.status, onModelsChanged]);

  const startImport = async () => {
    const value = hfUrl.trim();
    if (!HF_PATTERN.test(value)) {
      setError("Enter a valid Hugging Face repository URL or owner/model ID.");
      return;
    }
    setError("");
    try {
      const result = await importHuggingFaceModel(value);
      setTask({
        task_id: result.task_id,
        model_id: result.model_id,
        status: "downloading",
        progress: 0,
        error: null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the model import.");
    }
  };

  const removeModel = async (model: ManagedModel) => {
    if (!window.confirm(`Delete ${model.name}? This releases its local model files.`)) return;
    try {
      await deleteModel(model.id);
      await loadModels();
      onModelsChanged();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the model.");
    }
  };

  const totalSize = useMemo(
    () => models.reduce((total, model) => total + model.size_bytes, 0),
    [models],
  );

  return (
    <div className="model-management">
      <div className="model-page-header">
        <div>
          <span className="eyebrow">AI Assets</span>
          <h1>3D Model Management</h1>
          <p>Import, monitor, and manage local 3D generation models.</p>
        </div>
        <div className="storage-stats">
          <div><span>Local model storage</span><strong>{formatBytes(totalSize)}</strong></div>
          <div><span>Installed</span><strong>{models.length}</strong></div>
        </div>
      </div>

      <section className="hf-import-card">
        <div className="hf-import-copy">
          <span className="hf-mark">HF</span>
          <div>
            <h2>Import from Hugging Face</h2>
            <p>Download repository weights and files into a local extension.</p>
          </div>
        </div>
        <div className="hf-import-controls">
          <input
            value={hfUrl}
            onChange={(event) => setHfUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void startImport();
            }}
            placeholder="Paste Hugging Face URL or ID (e.g., https://huggingface.co/tencent/Hunyuan3D-2mini)"
            aria-label="Hugging Face repository"
          />
          <button type="button" className="import-button" onClick={() => void startImport()}>
            <span aria-hidden="true">↓</span> Import Model
          </button>
        </div>
        {task?.status === "downloading" && (
          <div className="download-progress" role="status">
            <div className="download-progress-label">
              <span>Downloading {task.model_id}</span>
              <strong>{task.progress}%</strong>
            </div>
            <div className="progress-track">
              <div style={{ width: `${task.progress}%` }} />
            </div>
            {task.eta && <small>{task.eta}</small>}
          </div>
        )}
        {task?.status === "completed" && (
          <div className="model-banner success">Import completed: {task.model_id}</div>
        )}
      </section>

      {error && <div className="model-banner error" role="alert">{error}</div>}

      <section className="installed-models">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Local Registry</span>
            <h2>Installed Models</h2>
          </div>
          <button type="button" className="refresh-models" onClick={() => void loadModels()}>↻ Refresh</button>
        </div>

        {loading ? (
          <div className="model-empty">Loading models...</div>
        ) : models.length === 0 ? (
          <div className="model-empty">No models are installed.</div>
        ) : (
          <div className="model-grid">
            {models.map((model) => (
              <article className="model-card" key={model.id}>
                <div className="model-card-top">
                  <span className="model-cube">◇</span>
                  <span className={`model-status ${model.cuda_ready ? "ready" : model.status.toLowerCase().includes("demo") ? "demo" : "missing"}`}>
                    {model.cuda_ready ? "Ready (CUDA)" : model.status}
                  </span>
                </div>
                <h3>{model.name}</h3>
                <dl>
                  <div><dt>Version</dt><dd>{model.version}</dd></div>
                  <div><dt>Storage</dt><dd>{formatBytes(model.size_bytes)}</dd></div>
                  <div><dt>Source</dt><dd>{model.source_url || "Local extension"}</dd></div>
                  <div><dt>Category</dt><dd>{model.storage_category}</dd></div>
                  <div><dt>Path</dt><dd title={model.local_path}>{model.local_path}</dd></div>
                  <div><dt>GPU</dt><dd>{model.requires_gpu ? "CUDA required" : "Standard / Demo"}</dd></div>
                </dl>
                <div className="model-actions">
                  <button
                    type="button"
                    onClick={() => window.alert(
                      model.cuda_ready
                        ? `${model.name} is ready for model ingest.`
                        : `Model ingest unavailable: ${model.status}`,
                    )}
                  >
                    Test Model Ingest
                  </button>
                  <button
                    type="button"
                    className="delete-model"
                    disabled={!model.removable}
                    title={model.removable ? "Delete downloaded model" : "Bundled model assets are managed with their extension"}
                    onClick={() => void removeModel(model)}
                  >
                    {model.removable ? "Delete Model" : "Bundled"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
