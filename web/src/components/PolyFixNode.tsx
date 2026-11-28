import {
  Handle,
  Position,
  type Edge,
  type EdgeChange,
  type Connection,
  type Node,
  type NodeChange,
  type NodeProps,
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useReactFlow,
  type Viewport,
} from "@xyflow/react";
import type { DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { RembgNodeView } from "./nodes/RembgNode";

export type PolyFixNodeStatus = "idle" | "queued" | "executing" | "completed" | "failed" | "warning" | "bypassed";

export interface PolyFixPort {
  id: string;
  type: "image" | "mesh" | "raw_mesh" | "quad_mesh" | "audit_data" | "metrics" | "baked_mesh" | "verified_mesh" | "spec" | "rules";
  label: string;
  direction: "in" | "out";
}

export interface PolyFixNodeData extends Record<string, unknown> {
  label: string;
  nodeNumber: string;
  category: string;
  status: PolyFixNodeStatus;
  progress: number;
  executionTimeMs?: number;
  errorMessage?: string;
  logs?: string[];
  isBypassed?: boolean;
  isMuted?: boolean;
  cacheToken?: string;
  params: Record<string, unknown>;
  preview?: string | null;
  ports: PolyFixPort[];
  onChooseImage?: () => void;
  onDropImage?: (event: DragEvent<HTMLDivElement>) => void;
  onRetry?: () => void;
  onUpdateParams?: (params: Record<string, unknown>) => void;
  resultUrl?: string | null;
  extensions?: Array<{
    id: string;
    name: string;
    is_ready: boolean;
    status_message: string;
    requires_gpu?: boolean;
  }>;
  selectedExtensionId?: string;
  onSelectExtension?: (extensionId: string) => void;
  onFixDependencies?: () => void;
  runStatus?: string;
  imageFile?: File | null;
  processedUrl?: string | null;
  filePath?: string | null;
  onDataChange?: (nodeId: string, changes: Record<string, unknown>) => void;
}

export type PolyFixNode = Node<PolyFixNodeData, "polyfix" | "rembg">;

const portColors: Record<PolyFixPort["type"], string> = {
  image: "#f59e0b",
  mesh: "#06b6d4",
  raw_mesh: "#06b6d4",
  quad_mesh: "#06b6d4",
  audit_data: "#a855f7",
  metrics: "#10b981",
  baked_mesh: "#06b6d4",
  verified_mesh: "#06b6d4",
  spec: "#a855f7",
  rules: "#a855f7",
};

const portCompatibility = (sourceType: PolyFixPort["type"], targetType: PolyFixPort["type"]) => {
  if (sourceType === targetType) return true;

  const meshTypes: PolyFixPort["type"][] = [
    "mesh",
    "raw_mesh",
    "quad_mesh",
    "baked_mesh",
    "verified_mesh",
  ];
  return meshTypes.includes(sourceType) && meshTypes.includes(targetType);
};

function PolyFixNodeView({ data }: NodeProps<PolyFixNode>) {
  const isExecuting = data.status === "executing";
  const statusClass = data.status === "idle" ? (data.isBypassed ? "bypassed" : "idle") : data.status;
  const statusStyle = isExecuting
    ? "border-amber-400 shadow-[0_0_20px_rgba(251,191,36,0.35)] animate-pulse"
    : data.status === "completed"
      ? "border-emerald-500/80 shadow-[0_0_15px_rgba(16,185,129,0.2)]"
      : data.status === "failed"
        ? "border-rose-500 shadow-[0_0_20px_rgba(244,63,94,0.35)]"
        : data.status === "warning"
          ? "border-amber-500 shadow-[0_0_20px_rgba(245,158,11,0.35)]"
        : "border-slate-700";

  return (
    <div
      className={`polyfix-node status-${statusClass}`}
      data-category={data.category.toLowerCase().replace(/\s+/g, "-")}
    >
      {data.ports.filter((port) => port.direction === "in").map((port, index, ports) => (
        <Handle
          key={port.id}
          type="target"
          position={Position.Left}
          id={port.id}
          className="typed-flow-handle !pointer-events-auto !z-[20]"
          style={{
            top: `${((index + 1) / (ports.length + 1)) * 100}%`,
            background: portColors[port.type],
          }}
          title={`${port.type}: typed input`}
        />
      ))}
      {data.ports.filter((port) => port.direction === "out").map((port, index, ports) => (
        <Handle
          key={port.id}
          type="source"
          position={Position.Right}
          id={port.id}
          className="typed-flow-handle !pointer-events-auto !z-[20]"
          style={{
            top: `${((index + 1) / (ports.length + 1)) * 100}%`,
            background: portColors[port.type],
          }}
          title={`${port.type}: typed output`}
        />
      ))}

      <div className={`polyfix-node-card bg-slate-900/90 backdrop-blur-md border rounded-xl shadow-2xl overflow-hidden transition-all duration-300 ${statusStyle}`}>
        <div className="polyfix-node-progress" aria-label={`${data.progress}% complete`}>
          <span style={{ width: `${data.progress}%` }} />
        </div>
        <div className="polyfix-node-header">
          <span className="node-number">{data.nodeNumber}</span>
          <div>
            <strong>{data.label}</strong>
            <small>{data.category}</small>
          </div>
          <span className={`node-status-dot ${statusClass}`} title={data.status} />
        </div>
        <div className="polyfix-node-body">
          {data.nodeNumber === "01" && (
            <div
              className={`polyfix-preview-dropzone ${data.preview ? "has-preview" : ""}`}
              role="button"
              tabIndex={0}
              onClick={data.onChooseImage}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") data.onChooseImage?.();
              }}
              onDrop={data.onDropImage}
              onDragOver={(event) => event.preventDefault()}
            >
              {data.preview ? <img src={data.preview} alt="Source preview" /> : (
                <span><strong>Drop image</strong><small>PNG / JPG / WEBP</small></span>
              )}
            </div>
          )}
          {data.nodeNumber === "02" && (
            <div className="node-conditioning-controls" onPointerDown={(event) => event.stopPropagation()}>
              <label>
                <span>Prompt / Style</span>
                <textarea
                  rows={2}
                  value={typeof data.params.prompt === "string" ? data.params.prompt : ""}
                  onChange={(event) => data.onUpdateParams?.({ ...data.params, prompt: event.target.value })}
                />
              </label>
              <label>
                <span>Target quads</span>
                <input
                  type="range"
                  min={500}
                  max={20000}
                  step={500}
                  value={typeof data.params.targetQuads === "number" ? data.params.targetQuads : 5000}
                  onChange={(event) => data.onUpdateParams?.({ ...data.params, targetQuads: Number(event.target.value) })}
                />
                <b>{typeof data.params.targetQuads === "number" ? data.params.targetQuads.toLocaleString() : "5,000"}</b>
              </label>
              <label>
                <span>Style preset</span>
                <select
                  value={typeof data.params.style === "string" ? data.params.style : "PBR Prop"}
                  onChange={(event) => data.onUpdateParams?.({ ...data.params, style: event.target.value })}
                >
                  <option>PBR Prop</option>
                  <option>Low Poly</option>
                  <option>Stylized</option>
                </select>
              </label>
            </div>
          )}
          {data.nodeNumber === "03" && (
            <div className="node-conditioning-controls" onPointerDown={(event) => event.stopPropagation()}>
              <label>
                <span>Negative prompt</span>
                <textarea
                  rows={2}
                  value={typeof data.params.negativePrompt === "string" ? data.params.negativePrompt : ""}
                  onChange={(event) => data.onUpdateParams?.({ ...data.params, negativePrompt: event.target.value })}
                />
              </label>
              <label>
                <span>Max Hausdorff</span>
                <input
                  type="range"
                  min={0.001}
                  max={0.05}
                  step={0.001}
                  value={typeof data.params.maxHausdorff === "number" ? data.params.maxHausdorff : 0.01}
                  onChange={(event) => data.onUpdateParams?.({ ...data.params, maxHausdorff: Number(event.target.value) })}
                />
                <b>{typeof data.params.maxHausdorff === "number" ? data.params.maxHausdorff.toFixed(3) : "0.010"}</b>
              </label>
              <label className="node-toggle">
                <span>Disallow UV overlap</span>
                <input
                  type="checkbox"
                  checked={typeof data.params.disallowUvOverlap === "boolean" ? data.params.disallowUvOverlap : true}
                  onChange={(event) => data.onUpdateParams?.({ ...data.params, disallowUvOverlap: event.target.checked })}
                />
              </label>
            </div>
          )}
          {data.nodeNumber === "04" && (
            <div className="node-model-controls" onPointerDown={(event) => event.stopPropagation()}>
              <label htmlFor={`model-select-${data.nodeNumber}`}>
                <span>Installed model</span>
                <select
                  id={`model-select-${data.nodeNumber}`}
                  value={data.selectedExtensionId ?? ""}
                  disabled={data.status === "executing"}
                  onChange={(event) => data.onSelectExtension?.(event.target.value)}
                >
                  <option value="">{data.extensions?.length ? "Select installed model" : "No installed models"}</option>
                  {data.extensions?.map((extension) => (
                    <option
                      key={extension.id}
                      value={extension.id}
                    >
                      {extension.name}{extension.is_ready ? "" : " - Missing dependencies"}
                    </option>
                  ))}
                </select>
              </label>
              {(() => {
                const selectedModel = data.extensions?.find((extension) => extension.id === data.selectedExtensionId);
                if (!selectedModel?.status_message) return null;
                return (
                  <>
                    <small className={`node-model-status ${selectedModel.is_ready ? "ready" : "missing"}`}>
                      {selectedModel.status_message}
                    </small>
                    {!selectedModel.is_ready && data.onFixDependencies && (
                      <button
                        type="button"
                        className="node-fix-deps-button"
                        onClick={data.onFixDependencies}
                      >
                        Fix / Install Dependencies
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
          )}
          {["05", "06", "07", "10"].includes(data.nodeNumber) && (
            <div className="node-metric-preview">
              <div><span>Cache</span><b>{data.cacheToken ? data.cacheToken.slice(0, 7) : "—"}</b></div>
              <div><span>Progress</span><b>{data.progress}%</b></div>
            </div>
          )}
          {data.nodeNumber === "08" && (
            <div className="node-metric-preview">
              <div><span>Topology</span><b>Check</b></div>
              <div><span>Retry</span><b>0 / 2</b></div>
              <div><span>Auto-repair</span><b>Ready</b></div>
            </div>
          )}
          {data.nodeNumber === "09" && (
            <div className="node-preview-placeholder viewport-preview">
              {data.runStatus === "failed" ? (
                <>
                  <strong className="node-run-error">Generation Failed</strong>
                  {data.onRetry && <button type="button" onClick={data.onRetry}>Retry Generation</button>}
                </>
              ) : data.runStatus === "starting" || data.runStatus === "processing" ? (
                <>
                  <span className="node-spinner active" />
                  <strong>{data.runStatus === "starting" ? "Starting" : "Processing"} {data.progress}%</strong>
                </>
              ) : data.resultUrl ? (
                <a href={data.resultUrl} target="_blank" rel="noreferrer">Open 3D result</a>
              ) : (
                <><span className="viewport-grid">GLB</span><strong>3D viewport</strong></>
              )}
            </div>
          )}
          {data.errorMessage && <div className="polyfix-node-error">{data.errorMessage}</div>}
        </div>
      </div>
    </div>
  );
}

const nodeTypes = { polyfix: PolyFixNodeView, rembg: RembgNodeView };

export interface PolyFixCanvasProps {
  nodes: PolyFixNode[];
  edges: Edge[];
  onNodesChange: (changes: NodeChange<PolyFixNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<Edge>[]) => void;
  onConnect: (edge: Edge) => void;
  onEdgeContextMenu: (event: ReactMouseEvent, edge: Edge) => void;
  onAddNode: (template: PolyFixNodeTemplate, position: { x: number; y: number }) => void;
  onDeleteNode: (nodeId: string) => void;
  onDuplicateNode: (node: PolyFixNode) => void;
  onToggleNodeBypass: (nodeId: string) => void;
  initialViewport?: Viewport | null;
  onViewportChange?: (viewport: Viewport) => void;
}

export interface PolyFixNodeTemplate {
  id: string;
  number: string;
  label: string;
  category: string;
  ports: PolyFixPort[];
}

const nodeCatalog: PolyFixNodeTemplate[] = [
  { id: "node_image_input", number: "01", label: "Source Image", category: "Input", ports: [{ id: "out_image", type: "image", label: "Image", direction: "out" }] },
  { id: "node_bg_remover", number: "01b", label: "Background Remover (rembg)", category: "Pre-process", ports: [{ id: "in_image", type: "image", label: "Input image", direction: "in" }, { id: "out_image", type: "image", label: "RGBA image", direction: "out" }] },
  { id: "node_spec_positive", number: "02", label: "Positive Specs", category: "Conditioning", ports: [{ id: "out_positive_spec", type: "spec", label: "Positive spec", direction: "out" }] },
  { id: "node_spec_negative", number: "03", label: "Negative Constraints", category: "Conditioning", ports: [{ id: "out_negative_rules", type: "rules", label: "Negative rules", direction: "out" }] },
  { id: "node_ai_generator", number: "04", label: "AI 3D Generator", category: "Model", ports: [{ id: "in_image", type: "image", label: "Image", direction: "in" }, { id: "in_spec", type: "spec", label: "Positive specs", direction: "in" }, { id: "out_raw_mesh", type: "raw_mesh", label: "Raw mesh", direction: "out" }] },
  { id: "node_audit_curvature", number: "05", label: "Geometry Audit (σ²)", category: "Core", ports: [{ id: "in_raw_mesh", type: "raw_mesh", label: "Raw mesh", direction: "in" }, { id: "out_raw_mesh", type: "raw_mesh", label: "Raw mesh", direction: "out" }, { id: "out_audit_data", type: "audit_data", label: "Audit data", direction: "out" }] },
  { id: "node_retopology_instant", number: "06", label: "Quad Retopology", category: "Core", ports: [{ id: "in_raw_mesh", type: "raw_mesh", label: "Raw mesh", direction: "in" }, { id: "in_audit_data", type: "audit_data", label: "Audit data", direction: "in" }, { id: "out_quad_mesh", type: "quad_mesh", label: "Quad mesh", direction: "out" }] },
  { id: "node_bake_pbr", number: "07", label: "UV & PBR Bake", category: "Core", ports: [{ id: "in_raw_mesh", type: "raw_mesh", label: "High-poly mesh", direction: "in" }, { id: "in_quad_mesh", type: "quad_mesh", label: "Low-poly mesh", direction: "in" }, { id: "out_baked_mesh", type: "baked_mesh", label: "Baked mesh", direction: "out" }] },
  { id: "node_gar_verifier", number: "08", label: "GAR Verifier & Repair", category: "Quality", ports: [{ id: "in_baked_mesh", type: "baked_mesh", label: "Baked mesh", direction: "in" }, { id: "in_raw_mesh", type: "raw_mesh", label: "Raw mesh", direction: "in" }, { id: "in_rules", type: "rules", label: "Negative rules", direction: "in" }, { id: "out_verified_mesh", type: "verified_mesh", label: "Verified mesh", direction: "out" }, { id: "out_metrics", type: "metrics", label: "GAR metrics", direction: "out" }] },
  { id: "node_3d_viewport", number: "09", label: "3D Output Viewport", category: "Output", ports: [{ id: "in_verified_mesh", type: "verified_mesh", label: "Verified mesh", direction: "in" }] },
  { id: "node_heatmap_viewer", number: "10", label: "Spatial Error Heatmap", category: "Diagnostic", ports: [{ id: "in_metrics", type: "metrics", label: "GAR metrics", direction: "in" }] },
];

function PolyFixFlow({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onEdgeContextMenu,
  onAddNode,
  onDeleteNode,
  onDuplicateNode,
  onToggleNodeBypass,
  initialViewport,
  onViewportChange,
}: PolyFixCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();
  const [menu, setMenu] = useState<{ x: number; y: number; flowPos: { x: number; y: number } } | null>(null);
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; node: PolyFixNode } | null>(null);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (menu) searchInputRef.current?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu && !nodeMenu) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(null);
        setNodeMenu(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [menu, nodeMenu]);

  const isValidConnection = (connection: Connection | Edge) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return false;
    if (!connection.sourceHandle || !connection.targetHandle) return false;

    const sourceNode = nodes.find((node) => node.id === connection.source);
    const targetNode = nodes.find((node) => node.id === connection.target);
    const sourcePort = sourceNode?.data.ports.find((port) => port.id === connection.sourceHandle && port.direction === "out");
    const targetPort = targetNode?.data.ports.find((port) => port.id === connection.targetHandle && port.direction === "in");
    if (!sourcePort || !targetPort) return false;

    return portCompatibility(sourcePort.type, targetPort.type);
  };

  const filteredCatalog = nodeCatalog.filter((item) => {
    const query = search.toLowerCase();
    return `${item.number} ${item.label}`.toLowerCase().includes(query)
      || item.category.toLowerCase().includes(query);
  });

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneClick={() => {
          setMenu(null);
          setNodeMenu(null);
        }}
        onPaneContextMenu={(event) => {
          event.preventDefault();
          setNodeMenu(null);
          const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
          setMenu({ x: event.clientX, y: event.clientY, flowPos });
          setSearch("");
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault();
          event.stopPropagation();
          setMenu(null);
          setNodeMenu({
            x: event.clientX,
            y: event.clientY,
            node: node as PolyFixNode,
          });
        }}
        isValidConnection={isValidConnection}
        defaultEdgeOptions={{ type: "default", style: { stroke: "#a855f7", strokeWidth: 2.5 } }}
        onConnect={(connection) => {
        const sourceNode = nodes.find((node) => node.id === connection.source);
        const sourcePort = sourceNode?.data.ports.find((port) => port.id === connection.sourceHandle && port.direction === "out");
        onConnect({
          id: `${connection.source}-${connection.sourceHandle}-${connection.target}-${connection.targetHandle}`,
          source: connection.source,
          target: connection.target,
          sourceHandle: connection.sourceHandle,
          targetHandle: connection.targetHandle,
          type: "default",
          animated: connection.source === "node_ai_generator",
          style: {
            stroke: sourcePort ? portColors[sourcePort.type] : "#a855f7",
            strokeWidth: 2.5,
          },
        });
        }}
        fitView={!initialViewport}
        defaultViewport={initialViewport ?? undefined}
        onMoveEnd={(_event, viewport) => onViewportChange?.(viewport)}
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.35}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="var(--color-grid-dot)" />
      <Controls position="bottom-right" showInteractive={false} />
      <MiniMap
        position="bottom-left"
        nodeColor={(node) => {
          const category = (node.data as PolyFixNodeData).category.toLowerCase();
          if (category.includes("input")) return "var(--color-node-input)";
          if (category.includes("ai model")) return "var(--color-node-generation)";
          if (category.includes("output")) return "var(--color-node-output)";
          return "var(--color-node-processing)";
        }}
        nodeStrokeColor="var(--color-divider)"
        maskColor="var(--color-minimap-mask)"
      />
      </ReactFlow>

      {menu && (
        <div
          className="node-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="node-context-menu-title">Add Node</div>
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            placeholder="Search nodes..."
            aria-label="Search nodes"
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="node-context-menu-list">
            {filteredCatalog.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  onAddNode(item, menu.flowPos);
                  setMenu(null);
                }}
              >
                <span>{item.number}. {item.label}</span>
                <small>{item.category}</small>
              </button>
            ))}
            {filteredCatalog.length === 0 && <div className="node-context-menu-empty">No matching nodes</div>}
          </div>
        </div>
      )}

      {nodeMenu && (
        <div
          className="node-action-menu"
          style={{ left: nodeMenu.x, top: nodeMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="node-action-menu-title">{nodeMenu.node.data.label}</div>
          <button
            type="button"
            onClick={() => {
              onDuplicateNode(nodeMenu.node);
              setNodeMenu(null);
            }}
          >
            <span className="node-action-icon duplicate">❐</span>
            Duplicate Node
          </button>
          <button
            type="button"
            onClick={() => {
              onToggleNodeBypass(nodeMenu.node.id);
              setNodeMenu(null);
            }}
          >
            <span className="node-action-icon bypass">⊘</span>
            {nodeMenu.node.data.isBypassed ? "Unbypass Node" : "Bypass Node"}
          </button>
          <div className="node-action-menu-divider" />
          <button
            type="button"
            className="node-action-delete"
            onClick={() => {
              onDeleteNode(nodeMenu.node.id);
              setNodeMenu(null);
            }}
          >
            Delete Node
          </button>
        </div>
      )}
    </div>
  );
}

export default function PolyFixCanvas(props: PolyFixCanvasProps) {
  return (
    <ReactFlowProvider>
      <PolyFixFlow {...props} />
    </ReactFlowProvider>
  );
}
