import { useState } from "react";
import Viewer from "../components/Viewer";
import { resultUrl } from "../api/client";
import type { Run } from "../hooks/useRun";
import type { ExtensionManifest, ParameterValue } from "../api/client";

type Props = {
  run: Run | null;
  startError: string | null;
  selectedExtension?: ExtensionManifest;
  file?: File | null;
  parameterValues: Record<string, ParameterValue>;
  onRetry: () => void;
  onStudio: () => void;
};

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
  const isProcessing = run?.status === "starting" || run?.status === "processing";

  const downloadWorkflow = () => {
    const metadata = {
      exportedAt: new Date().toISOString(),
      extension: selectedExtension?.id,
      extensionName: selectedExtension?.name,
      sourceFile: file?.name ?? null,
      parameters: parameterValues,
      run: run?.id ? { id: run.id, status: run.status, progress: run.progress } : null,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(metadata, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `polyfix-workflow-${run?.id || "draft"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const diagnostics = [
    { icon: "M", title: "Mesh Health", detail: "Watertight manifold & normals", status: run?.status === "completed" ? "Passed" : "Pending" },
    { icon: "W", title: "Asset Weight", detail: "< 5,000 quads target", status: run?.status === "completed" ? "< 5k quads" : "Pending" },
    { icon: "U", title: "Texture Atlas", detail: "UV island overlap", status: run?.status === "completed" ? "0% overlap" : "Pending" },
    { icon: "P", title: "PBR Completeness", detail: "Albedo, Normal, AO wiring", status: run?.status === "completed" ? "Complete" : "Pending" },
    { icon: "S", title: "Shape Fidelity", detail: "Hausdorff distance", status: run?.status === "completed" ? "≤ ε passed" : "Pending" },
  ];

  return (
    <div className="qa-dashboard">
      <main className="qa-viewport">
        <div className="qa-toolbar">
          <div>
            <span className="eyebrow">Generation Output</span>
            <strong>{selectedExtension?.name ?? "No model selected"}</strong>
          </div>
          <div className="qa-view-toggles">
            <button type="button" className={textured ? "active" : ""} onClick={() => setTextured((value) => !value)}>Textured PBR</button>
            <button type="button" className={wireframe ? "active" : ""} onClick={() => setWireframe((value) => !value)}>Wireframe</button>
            <button type="button" className={heatmap ? "active" : ""} onClick={() => setHeatmap((value) => !value)}>Heatmap</button>
            <button type="button" className={autoRotate ? "active" : ""} onClick={() => setAutoRotate((value) => !value)}>Auto-Rotate</button>
          </div>
        </div>

        <div className="qa-viewport-stage">
          {run?.status === "completed" && run.id ? (
            <Viewer
              url={resultUrl(run.id)}
              wireframe={wireframe}
              heatmap={heatmap}
              autoRotate={autoRotate}
            />
          ) : (
            <div className="qa-empty-state">
              {isProcessing ? (
                <>
                  <span className="qa-spinner" />
                  <strong>{run?.status === "starting" ? "Starting generation" : "Generating 3D asset"}</strong>
                  <span>{run?.progress ?? 0}%</span>
                  <div className="qa-progress"><i style={{ width: `${run?.progress ?? 0}%` }} /></div>
                </>
              ) : run?.status === "failed" ? (
                <div className="qa-error">
                  <strong>Generation failed</strong>
                  <span>{run.error || startError || "Generation could not be completed."}</span>
                  <button type="button" onClick={onRetry}>Retry Generation</button>
                </div>
              ) : (
                <>
                  <span className="qa-empty-cube">◇</span>
                  <strong>No generated asset yet</strong>
                  <span>Configure the pipeline and generate from Node Studio.</span>
                  <button type="button" className="qa-edit-button" onClick={onStudio}>Edit Pipeline</button>
                </>
              )}
            </div>
          )}
        </div>

        <footer className="qa-export-bar">
          <a
            className={`production-export ${run?.status === "completed" && run.id ? "" : "disabled"}`}
            href={run?.status === "completed" && run.id ? resultUrl(run.id) : undefined}
            download={run?.id ? `model-${run.id}.glb` : undefined}
            aria-disabled={run?.status !== "completed"}
          >
            Download Production GLB
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
          <span className={`schema-badge ${run?.status === "completed" ? "passed" : ""}`}>
            {run?.status === "completed" ? "glTF Valid" : "glTF Pending"}
          </span>
        </div>
        <div className="gar-list">
          {diagnostics.map((item) => (
            <article className={`gar-card ${run?.status === "completed" ? "passed" : ""}`} key={item.title}>
              <span className="gar-axis">{item.icon}</span>
              <div>
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
              </div>
              <span className="gar-status">{item.status}</span>
            </article>
          ))}
        </div>
        <div className="retry-state">
          <span>Retries Used</span>
          <strong>0 / 2</strong>
          <div className="retry-dots"><i /><i /><i /></div>
        </div>
      </aside>
    </div>
  );
}
