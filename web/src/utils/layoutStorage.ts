import type { Edge, Viewport } from "@xyflow/react";
import type { ParameterValue } from "../api/client";
import type { PolyFixNode, PolyFixPort } from "../components/PolyFixNode";

export const LAYOUT_STORAGE_KEY = "polyfix.ui.layout.v1";

export type SavedNodeBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SavedFlowNode = {
  id: string;
  type: "polyfix" | "rembg";
  position: { x: number; y: number };
  data: {
    label: string;
    nodeNumber: string;
    category: string;
    params: Record<string, unknown>;
    ports: PolyFixPort[];
    isBypassed?: boolean;
    isMuted?: boolean;
  };
};

export type SavedLayoutConfig = {
  version: 1;
  activeView: "studio" | "qa";
  isSidebarOpen: boolean;
  isPropertiesOpen: boolean;
  selectedExt: string;
  parameterValues: Record<string, ParameterValue>;
  nodes: SavedFlowNode[];
  edges: Edge[];
  viewport: Viewport | null;
  canvasView: { x: number; y: number; zoom: number };
  inputBox: SavedNodeBox;
  outputBox: SavedNodeBox;
};

export function serializeFlowNodes(nodes: PolyFixNode[]): SavedFlowNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type === "rembg" ? "rembg" : "polyfix",
    position: { x: node.position.x, y: node.position.y },
    data: {
      label: node.data.label,
      nodeNumber: node.data.nodeNumber,
      category: node.data.category,
      params: { ...(node.data.params ?? {}) },
      ports: (node.data.ports ?? []).map((port) => ({ ...port })),
      isBypassed: node.data.isBypassed,
      isMuted: node.data.isMuted,
    },
  }));
}

export function serializeFlowEdges(edges: Edge[]): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    type: edge.type,
    style: edge.style,
  }));
}

export function loadLayoutConfig(): Partial<SavedLayoutConfig> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedLayoutConfig>;
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveLayoutConfig(config: SavedLayoutConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore quota or storage access errors so UI interactions never fail.
  }
}

export function clearLayoutConfig(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LAYOUT_STORAGE_KEY);
  } catch {
    // Ignore storage access errors.
  }
}
