import type { Edge } from "@xyflow/react";
import type { PolyFixNode } from "../components/PolyFixNode";

export interface ResolvedPipelinePayload {
  imageId: string | null;
  extensionId: string;
  positiveSpecs: {
    prompt?: string;
    targetQuads?: number;
    style?: string;
  };
  negativeConstraints: {
    negativePrompt?: string;
    maxHausdorff?: number;
    disallowUvOverlap?: boolean;
  };
  nodeOverrides: Record<string, unknown>;
}

export function topologicalNodeOrder(nodes: PolyFixNode[], edges: Edge[]): PolyFixNode[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const inDegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));

  edges.forEach((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return;
    outgoing.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  });

  const queue = nodes.filter((node) => inDegree.get(node.id) === 0);
  const ordered: PolyFixNode[] = [];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) break;
    ordered.push(node);
    outgoing.get(node.id)?.forEach((targetId) => {
      const nextDegree = (inDegree.get(targetId) ?? 1) - 1;
      inDegree.set(targetId, nextDegree);
      if (nextDegree === 0) {
        const target = nodes.find((item) => item.id === targetId);
        if (target) queue.push(target);
      }
    });
  }
  return ordered;
}

export function resolveGraphExecution(
  nodes: PolyFixNode[],
  edges: Edge[],
  extensionId = "",
): ResolvedPipelinePayload {
  topologicalNodeOrder(nodes, edges);

  const sourceEdges = new Map<string, Edge[]>();
  edges.forEach((edge) => {
    sourceEdges.set(edge.target, [...(sourceEdges.get(edge.target) ?? []), edge]);
  });

  const positiveNode = nodes.find((node) =>
    node.id === "node_spec_positive"
    || node.data.label === "Positive Specs",
  );
  const negativeNode = nodes.find((node) =>
    node.id === "node_spec_negative"
    || node.data.label === "Negative Constraints",
  );

  const positiveConnected = !!positiveNode && !positiveNode.data.isBypassed
    && (sourceEdges.get("node_ai_generator") ?? []).some((edge) => edge.source === positiveNode.id && edge.targetHandle === "in_spec");
  const negativeConnected = !!negativeNode && !negativeNode.data.isBypassed
    && (sourceEdges.get("node_gar_verifier") ?? []).some((edge) => edge.source === negativeNode.id && edge.targetHandle === "in_rules");

  const positiveParams = positiveConnected ? positiveNode?.data.params ?? {} : {};
  const negativeParams = negativeConnected ? negativeNode?.data.params ?? {} : {};
  const imageNode = nodes.find((node) => node.id === "node_image_input");

  return {
    imageId: imageNode?.data.cacheToken ? String(imageNode.data.cacheToken) : null,
    extensionId,
    positiveSpecs: {
      prompt: typeof positiveParams.prompt === "string" ? positiveParams.prompt : "",
      targetQuads: typeof positiveParams.targetQuads === "number" ? positiveParams.targetQuads : 5000,
      style: typeof positiveParams.style === "string" ? positiveParams.style : "PBR Prop",
    },
    negativeConstraints: {
      negativePrompt: typeof negativeParams.negativePrompt === "string" ? negativeParams.negativePrompt : "",
      maxHausdorff: typeof negativeParams.maxHausdorff === "number" ? negativeParams.maxHausdorff : 0.01,
      disallowUvOverlap: typeof negativeParams.disallowUvOverlap === "boolean" ? negativeParams.disallowUvOverlap : true,
    },
    nodeOverrides: {
      prompt: positiveParams.prompt ?? "",
      targetQuads: positiveParams.targetQuads ?? 5000,
      style: positiveParams.style ?? "PBR Prop",
      negativePrompt: negativeParams.negativePrompt ?? "",
      maxHausdorff: negativeParams.maxHausdorff ?? 0.01,
      disallowUvOverlap: negativeParams.disallowUvOverlap ?? true,
    },
  };
}
