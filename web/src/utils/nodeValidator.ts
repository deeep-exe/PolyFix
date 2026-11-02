export interface NodeValidationError {
  nodeId: string;
  nodeName: string;
  type: "missing_connection" | "missing_input" | "invalid_param";
  message: string;
}

export function validateNodeGraph(nodes: any[], edges: any[]): NodeValidationError[] {
  const errors: NodeValidationError[] = [];

  nodes.forEach((node) => {
    const isGenerator =
      node.type === "node_ai_generator"
      || node.type === "aiGenerator"
      || node.id === "node_ai_generator";

    if (isGenerator) {
      const hasImageInput = edges.some(
        (edge) =>
          edge.target === node.id
          && (edge.targetHandle === "in_image" || !edge.targetHandle),
      );
      if (!hasImageInput && !node.data?.imageFile && !node.data?.cacheToken) {
        errors.push({
          nodeId: node.id,
          nodeName: node.data?.label || "3D AI Generator",
          type: "missing_input",
          message: "No Source Image connected to generator input port.",
        });
      }

      const extensions = node.data?.extensions as Array<{ id: string; is_ready: boolean; status_message?: string }> | undefined;
      const selectedId = node.data?.selectedExtensionId as string | undefined;
      const selected = extensions?.find((extension) => extension.id === selectedId);
      if (selected && !selected.is_ready) {
        errors.push({
          nodeId: node.id,
          nodeName: node.data?.label || "3D AI Generator",
          type: "invalid_param",
          message: selected.status_message || "Selected extension is not ready to execute.",
        });
      }
    }
  });

  return errors;
}
