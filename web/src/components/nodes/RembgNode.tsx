import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useState } from "react";
import type { PolyFixNodeData } from "../PolyFixNode";

type RembgData = PolyFixNodeData & {
  imageFile?: File | null;
  processedUrl?: string | null;
  filePath?: string | null;
  onDataChange?: (nodeId: string, changes: Record<string, unknown>) => void;
};

export type RembgNode = Node<RembgData, "rembg">;

export function RembgNodeView({ id, data }: NodeProps<RembgNode>) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [processedUrl, setProcessedUrl] = useState<string | null>(data.processedUrl ?? null);

  const handleRun = async () => {
    if (!data.imageFile) {
      setError("No input image connected or uploaded.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("file", data.imageFile);
      const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
      const response = await fetch(`${apiBase}/api/nodes/remove-bg`, {
        method: "POST",
        body: formData,
      });
      const result = await response.json() as {
        output_url?: string;
        file_path?: string;
        detail?: string;
      };
      if (!response.ok || !result.output_url) {
        throw new Error(result.detail ?? "Background removal failed.");
      }

      const fullUrl = result.output_url.startsWith("http")
        ? result.output_url
        : `${apiBase}${result.output_url}`;
      setProcessedUrl(fullUrl);
      data.onDataChange?.(id, {
        processedUrl: fullUrl,
        filePath: result.file_path ?? null,
        preview: fullUrl,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run rembg.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="polyfix-node-card bg-slate-900/90 border border-slate-700 rounded-xl shadow-2xl overflow-hidden">
      <Handle
        type="target"
        position={Position.Left}
        id="in_image"
        className="!h-3 !w-3 !border-2 !border-amber-500 !bg-amber-400"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="out_image"
        className="!h-3 !w-3 !border-2 !border-amber-500 !bg-amber-400"
      />
      <div className="polyfix-node-header">
        <span className="node-number">{data.nodeNumber}</span>
        <div><strong>{data.label}</strong><small>{data.category}</small></div>
        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">rembg</span>
      </div>
      <div className="polyfix-node-body space-y-2" onPointerDown={(event) => event.stopPropagation()}>
        {processedUrl ? (
          <img className="w-full h-28 object-contain rounded border border-slate-800 bg-slate-950" src={processedUrl} alt="Background removed" />
        ) : (
          <div className="flex h-20 w-full items-center justify-center rounded border border-dashed border-slate-800 text-[11px] text-slate-500">
            {loading ? "Removing background..." : "Ready to process"}
          </div>
        )}
        <button
          type="button"
          onClick={handleRun}
          disabled={loading}
          className="w-full rounded bg-amber-600 py-1.5 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
        >
          {loading ? "Processing..." : "Run rembg"}
        </button>
        {error && <div className="polyfix-node-error">{error}</div>}
      </div>
    </div>
  );
}
