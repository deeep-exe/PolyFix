import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import Viewer from "../components/Viewer";
import {
  MODEL_FILE_ACCEPT,
  assetFileUrl,
  importModelFile,
  importRunOutput,
  optimizeAsset,
  resultUrl,
} from "../api/client";
import type { Run } from "../hooks/useRun";
import type {
  AssetVariant,
  ExtensionManifest,
  ModelAsset,
  OptimizeSettings,
  ParameterValue,
  QaCheckId,
  QaReport,
} from "../api/client";

type Props = {
  run: Run | null;
  startError: string | null;
  selectedExtension?: ExtensionManifest;
  file?: File | null;
  parameterValues: Record<string, ParameterValue>;
  onRetry: () => void;
  onStudio: () => void;
};

type LoadedAsset = ModelAsset & { fromRunId?: string };

const TRIANGLE_BUDGET = 10_000;

const AXES: { id: QaCheckId; icon: string; title: string; detail: string }[] = [
  { id: "mesh_health", icon: "M", title: "Mesh Health", detail: "Watertight manifold & normals" },
  { id: "asset_weight", icon: "W", title: "Asset Weight", detail: "≤ 10k tris (≈ 5,000 quads)" },
  { id: "texture_atlas", icon: "U", title: "Texture Atlas", detail: "UV island overlap" },
  { id: "pbr_completeness", icon: "P", title: "PBR Completeness", detail: "Albedo, Normal, AO, MR maps" },
  { id: "shape_fidelity", icon: "S", title: "Shape Fidelity", detail: "Hausdorff vs original (≤ 1%)" },
];

const DEFAULT_SETTINGS: OptimizeSettings = {
  target_ratio: 0.5,
  merge_vertices: true,
  remove_degenerate: true,
  fix_normals: true,
  fill_holes: false,
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function percentChange(before: number, after: number) {
  if (!before) return "";
  const change = ((after - before) / before) * 100;
  return `${change > 0 ? "+" : ""}${change.toFixed(0)}%`;
}

export default function GenerationDashboard({
  run,
  startError,
  selectedExtension,
  file,
  parameterValues,
  onRetry,
  onStudio,
}: Props) {
  const [textured, setTextured] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [heatmap, setHeatmap] = useState(false);
  const [autoRotate, setAutoRotate] = useState(true);

  const [asset, setAsset] = useState<LoadedAsset | null>(null);
  const [variant, setVariant] = useState<AssetVariant>("original");
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<null | "importing" | "analysing" | "optimizing">(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [settings, setSettings] = useState<OptimizeSettings>(DEFAULT_SETTINGS);
  const [isDragging, setIsDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const isProcessing = run?.status === "starting" || run?.status === "processing";
  const runCompleted = run?.status === "completed" && !!run.id;
  // A model analysed from an older generation run stops being shown once a new run exists.
  const activeAsset = asset && (!asset.fromRunId || asset.fromRunId === run?.id) ? asset : null;
  const report: QaReport | null = activeAsset
    ? (variant === "optimized" && activeAsset.optimized) || activeAsset.original
    : null;
  const shownVariant: AssetVariant = activeAsset && variant === "optimized" && activeAsset.optimized ? "optimized" : "original";
  const viewerUrl = activeAsset
    ? assetFileUrl(activeAsset.id, shownVariant, version)
    : runCompleted ? resultUrl(run!.id) : null;

  const loadAsset = (next: LoadedAsset) => {
    setAsset(next);
    setVariant("original");
    setVersion((value) => value + 1);
    setSettings({
      ...DEFAULT_SETTINGS,
      target_ratio: next.original.stats.faces > TRIANGLE_BUDGET * 2 ? 0.25 : 0.5,
    });
  };

  const openFile = async (picked: File | undefined) => {
    if (!picked) return;
    setBusy("importing");
    setAssetError(null);
    try {
      loadAsset(await importModelFile(picked));
    } catch (error) {
      setAssetError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    void openFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (!busy) void openFile(event.dataTransfer.files?.[0]);
  };

  const analyseRun = async () => {
    if (!run?.id) return;
    setBusy("analysing");
    setAssetError(null);
    try {
      loadAsset({ ...(await importRunOutput(run.id)), fromRunId: run.id });
    } catch (error) {
      setAssetError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const optimize = async () => {
    if (!activeAsset) return;
    setBusy("optimizing");
    setAssetError(null);
    try {
      const updated = await optimizeAsset(activeAsset.id, settings);
      setAsset({ ...updated, fromRunId: activeAsset.fromRunId });
      setVariant("optimized");
      setVersion((value) => value + 1);
    } catch (error) {
      setAssetError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const closeAsset = () => {
    setAsset(null);
    setAssetError(null);
  };

  const downloadWorkflow = () => {
    const metadata = {
      exportedAt: new Date().toISOString(),
      extension: selectedExtension?.id,
      extensionName: selectedExtension?.name,
      sourceFile: activeAsset?.name ?? file?.name ?? null,
      parameters: parameterValues,
      run: run?.id ? { id: run.id, status: run.status, progress: run.progress } : null,
      qa: activeAsset
        ? { original: activeAsset.original, optimized: activeAsset.optimized, optimizeSettings: activeAsset.settings }
        : null,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(metadata, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `polyfix-workflow-${activeAsset?.id || run?.id || "draft"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const originalFaces = activeAsset?.original.stats.faces ?? 0;
  const keptFaces = Math.max(4, Math.round(originalFaces * settings.target_ratio));
  const downloadName = activeAsset
    ? `${activeAsset.name.replace(/\.[^.]+$/, "")}-${shownVariant}.glb`
    : run?.id ? `model-${run.id}.glb` : undefined;
  const allPassed = !!report && report.checks.every((check) => check.status === "pass" || check.status === "info");

  return (
    <div className="qa-dashboard">
      <input
        ref={fileInput}
        type="file"
        accept={MODEL_FILE_ACCEPT}
        hidden
        onChange={onFileChange}
      />
      <main className="qa-viewport">
        <div className="qa-toolbar">
          <div className="qa-title">
            <span className="eyebrow">{activeAsset ? (activeAsset.fromRunId ? "Generated Model" : "Imported Model") : "Generation Output"}</span>
            <strong title={activeAsset?.name}>
              {activeAsset?.name ?? selectedExtension?.name ?? "No model selected"}
            </strong>
          </div>
          <div className="qa-view-toggles">
            <button
              type="button"
              className="qa-open-button"
              onClick={() => fileInput.current?.click()}
              disabled={!!busy}
              title={`Open a 3D model (${MODEL_FILE_ACCEPT.replaceAll(",", ", ")})`}
            >
              {busy === "importing" ? "Opening…" : "Open Model"}
            </button>
            {activeAsset?.optimized && (
              <span className="qa-variant-switch" role="group" aria-label="Model version">
                <button type="button" className={shownVariant === "original" ? "active" : ""} onClick={() => setVariant("original")}>Original</button>
                <button type="button" className={shownVariant === "optimized" ? "active" : ""} onClick={() => setVariant("optimized")}>Optimised</button>
              </span>
            )}
            <button type="button" className={textured ? "active" : ""} onClick={() => setTextured((value) => !value)}>Textured PBR</button>
            <button type="button" className={wireframe ? "active" : ""} onClick={() => setWireframe((value) => !value)}>Wireframe</button>
            <button type="button" className={heatmap ? "active" : ""} onClick={() => setHeatmap((value) => !value)}>Heatmap</button>
            <button type="button" className={autoRotate ? "active" : ""} onClick={() => setAutoRotate((value) => !value)}>Auto-Rotate</button>
            {activeAsset && (
              <button type="button" onClick={closeAsset} title="Close this model" aria-label="Close model">✕</button>
            )}
          </div>
        </div>

        <div
          className={`qa-viewport-stage ${isDragging ? "dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            if (!isDragging) setIsDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false);
          }}
          onDrop={onDrop}
        >
          {isProcessing && !activeAsset ? (
            <div className="qa-empty-state">
              <span className="qa-spinner" />
              <strong>{run?.status === "starting" ? "Starting generation" : "Generating 3D asset"}</strong>
              <span>{run?.progress ?? 0}%</span>
              <div className="qa-progress"><i style={{ width: `${run?.progress ?? 0}%` }} /></div>
            </div>
          ) : busy === "importing" || busy === "analysing" ? (
            <div className="qa-empty-state">
              <span className="qa-spinner" />
              <strong>{busy === "importing" ? "Opening model" : "Analysing model"}</strong>
              <span>Converting and running the quality gates…</span>
            </div>
          ) : viewerUrl ? (
            <Viewer
              key={viewerUrl}
              url={viewerUrl}
              wireframe={wireframe}
              heatmap={heatmap}
              autoRotate={autoRotate}
            />
          ) : run?.status === "failed" ? (
            <div className="qa-empty-state">
              <div className="qa-error">
                <strong>Generation failed</strong>
                <span>{run.error || startError || "Generation could not be completed."}</span>
                <button type="button" onClick={onRetry}>Retry Generation</button>
              </div>
            </div>
          ) : (
            <div className="qa-empty-state">
              <span className="qa-empty-cube">◇</span>
              <strong>No model loaded</strong>
              <span>Generate one in Node Studio, or open an existing 3D file to check and optimise it.</span>
              <div className="qa-empty-actions">
                <button type="button" className="qa-edit-button" onClick={() => fileInput.current?.click()}>Open 3D Model</button>
                <button type="button" className="qa-secondary-button" onClick={onStudio}>Edit Pipeline</button>
              </div>
              <small>GLB, glTF, OBJ, STL, PLY or OFF · or drop a file here</small>
            </div>
          )}
          {isDragging && <div className="qa-drop-overlay">Drop to open model</div>}
          {busy === "optimizing" && (
            <div className="qa-busy-overlay"><span className="qa-spinner" /> Optimising…</div>
          )}
          {assetError && (
            <div className="qa-asset-error" role="alert">
              <span>{assetError}</span>
              <button type="button" onClick={() => setAssetError(null)} aria-label="Dismiss error">✕</button>
            </div>
          )}
        </div>

        <footer className="qa-export-bar">
          <a
            className={`production-export ${viewerUrl ? "" : "disabled"}`}
            href={viewerUrl ?? undefined}
            download={downloadName}
            aria-disabled={!viewerUrl}
          >
            {activeAsset?.optimized && shownVariant === "optimized" ? "Download Optimised GLB" : "Download Production GLB"}
          </a>
          <button type="button" onClick={downloadWorkflow}>Export Workflow Metadata</button>
          <button type="button" className="qa-edit-button" onClick={onStudio}>Edit Pipeline in Studio</button>
        </footer>
      </main>

      <aside className="gar-panel">
        <div className="gar-heading">
          <div>
            <span className="eyebrow">Quality Gates</span>
            <h2>5-Axis GAR</h2>
          </div>
          <span className={`schema-badge ${allPassed ? "passed" : ""}`}>
            {report ? `${activeAsset!.source_format.toUpperCase()} · ${shownVariant === "optimized" ? "Optimised" : "Original"}` : "glTF Pending"}
          </span>
        </div>
        <div className="gar-list">
          {AXES.map((axis) => {
            const check = report?.checks.find((item) => item.id === axis.id);
            const status = check?.status ?? "pending";
            return (
              <article className={`gar-card ${status === "pass" ? "passed" : ""} gar-${status}`} key={axis.id}>
                <span className="gar-axis">{axis.icon}</span>
                <div>
                  <strong>{axis.title}</strong>
                  <small>{check?.detail?.length ? check.detail.join(", ") : axis.detail}</small>
                </div>
                <span className="gar-status">{check?.value ?? "Pending"}</span>
              </article>
            );
          })}
        </div>

        {!activeAsset && runCompleted && (
          <button type="button" className="qa-edit-button gar-action" onClick={() => void analyseRun()} disabled={!!busy}>
            {busy === "analysing" ? "Analysing…" : "Analyse & Optimise Output"}
          </button>
        )}

        {activeAsset ? (
          <section className="optimize-panel" aria-label="Optimise model">
            <span className="eyebrow">Optimise</span>
            <label className="optimize-slider">
              <span>
                Keep {Math.round(settings.target_ratio * 100)}% of triangles
                <small>≈ {keptFaces.toLocaleString()} of {originalFaces.toLocaleString()}</small>
              </span>
              <input
                type="range"
                min={0.02}
                max={1}
                step={0.01}
                value={settings.target_ratio}
                onChange={(event) => setSettings((current) => ({ ...current, target_ratio: Number(event.target.value) }))}
              />
            </label>
            {originalFaces > TRIANGLE_BUDGET && (
              <button
                type="button"
                className="qa-secondary-button"
                onClick={() => setSettings((current) => ({ ...current, target_ratio: Math.max(0.02, TRIANGLE_BUDGET / originalFaces) }))}
              >
                Fit 10k-triangle budget
              </button>
            )}
            {([
              ["merge_vertices", "Weld duplicate vertices"],
              ["remove_degenerate", "Remove degenerate & duplicate faces"],
              ["fix_normals", "Fix normals & winding"],
              ["fill_holes", "Fill small holes"],
            ] as const).map(([key, label]) => (
              <label className="optimize-option" key={key}>
                <input
                  type="checkbox"
                  checked={settings[key]}
                  onChange={(event) => setSettings((current) => ({ ...current, [key]: event.target.checked }))}
                />
                {label}
              </label>
            ))}
            <button type="button" className="qa-edit-button" onClick={() => void optimize()} disabled={!!busy}>
              {busy === "optimizing" ? "Optimising…" : activeAsset.optimized ? "Re-optimise" : "Optimise Model"}
            </button>

            {activeAsset.optimized && (
              <dl className="optimize-compare">
                <dt>Triangles</dt>
                <dd>
                  {activeAsset.original.stats.faces.toLocaleString()} → {activeAsset.optimized.stats.faces.toLocaleString()}
                  <em>{percentChange(activeAsset.original.stats.faces, activeAsset.optimized.stats.faces)}</em>
                </dd>
                <dt>Vertices</dt>
                <dd>
                  {activeAsset.original.stats.vertices.toLocaleString()} → {activeAsset.optimized.stats.vertices.toLocaleString()}
                  <em>{percentChange(activeAsset.original.stats.vertices, activeAsset.optimized.stats.vertices)}</em>
                </dd>
                <dt>GLB size</dt>
                <dd>
                  {formatBytes(activeAsset.original.stats.file_size)} → {formatBytes(activeAsset.optimized.stats.file_size)}
                  <em>{percentChange(activeAsset.original.stats.file_size, activeAsset.optimized.stats.file_size)}</em>
                </dd>
                <dt>Max deviation</dt>
                <dd>{((activeAsset.optimized.stats.hausdorff ?? 0) * 100).toFixed(2)}% of size</dd>
              </dl>
            )}
          </section>
        ) : (
          <div className="retry-state">
            <span>Retries Used</span>
            <strong>0 / 2</strong>
            <div className="retry-dots"><i /><i /><i /></div>
          </div>
        )}
      </aside>
    </div>
  );
}
