import {
  useEffect,
  useCallback,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  checkBackendConnection,
  getExtensions,
  getModels,
  deleteExtension as deleteExtensionApi,
  checkExtensionDeps,
  checkNodePreflight,
  installExtensionDeps,
  resultUrl,
  type BackendConnectionState,
  type ExtensionDependencyAudit,
  type ExtensionManifest,
  type ManagedModel,
  type ParameterValue,
  fetchExtensionDocs,
  type ExtensionDocs,
} from "./api/client";
import InstallExtension from "./components/InstallExtension";
import DependencyPromptModal from "./components/DependencyPromptModal";
import Viewer from "./components/Viewer";
import ExtensionDocPanel from "./components/ExtensionDocPanel";
import { useRun } from "./hooks/useRun";
import PolyFixCanvas, { type PolyFixNode, type PolyFixNodeStatus, type PolyFixNodeTemplate } from "./components/PolyFixNode";
import { useDownloads } from "./hooks/useDownloads";
import Header from "./components/Header";
import GenerationDashboard from "./pages/GenerationDashboard";
import { resolveGraphExecution } from "./utils/graphTraversal";
import { validateNodeGraph } from "./utils/nodeValidator";
import {
  addEdge,
  useEdgesState,
  useNodesState,
  type Edge,
  type Viewport,
} from "@xyflow/react";
import {
  clearLayoutConfig,
  loadLayoutConfig,
  saveLayoutConfig,
  serializeFlowEdges,
  serializeFlowNodes,
  type SavedLayoutConfig,
} from "./utils/layoutStorage";

function CubeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 2 8.5 4.9v9.8L12 22l-8.5-5.3V6.9L12 2Z" />
      <path d="m3.8 7 8.2 4.9L20.2 7M12 12v9.7" />
    </svg>
  );
}

type NodeBox = { x: number; y: number; width: number; height: number };
type ExtensionContextMenu = { extension: ExtensionManifest; x: number; y: number };
type EdgeContextMenu = { edgeId: string; x: number; y: number };
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function validateImageFile(file: File): string | null {
  if (file.size > MAX_IMAGE_SIZE) return "File exceeds 10 MB limit.";
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) return "Unsupported format. Use PNG, JPEG, or WEBP.";
  return null;
}

function isMockModel(item: { id: string; name: string; type?: string }) {
  const id = item.id.toLowerCase();
  const name = item.name.toLowerCase();
  return id.startsWith("mock") || name.startsWith("mock ") || item.type?.toLowerCase() === "mock";
}

async function fetchInstalledModels(): Promise<ExtensionManifest[]> {
  const [extResult, modelsResult] = await Promise.allSettled([
    getExtensions(),
    getModels(),
  ]);

  const rawExtensions = extResult.status === "fulfilled" ? extResult.value : [];
  const managedModels: ManagedModel[] = modelsResult.status === "fulfilled" ? modelsResult.value : [];

  if (extResult.status === "rejected" && modelsResult.status === "rejected") {
    throw extResult.reason instanceof Error
      ? extResult.reason
      : new Error("Could not load installed models.");
  }

  const installedById = new Map(
    managedModels
      .filter((model) => model.installed && !isMockModel(model))
      .map((model) => [model.id, model]),
  );

  const filtered = rawExtensions.filter((item) => {
    if (isMockModel(item)) return false;
    if (modelsResult.status === "fulfilled") {
      return installedById.has(item.id);
    }
    return true;
  });

  for (const model of installedById.values()) {
    if (!filtered.some((item) => item.id === model.id)) {
      filtered.push({
        id: model.id,
        name: model.name,
        version: model.version,
        type: model.type,
        requires_gpu: model.requires_gpu,
        is_ready: model.cuda_ready,
        status_message: model.status,
        removable: model.removable,
        storage_path: model.local_path,
        source_url: model.source_url,
      });
    }
  }

  return filtered;
}

function getParameterDefault(parameter: NonNullable<ExtensionManifest["parameters"]>[string]): ParameterValue {
  if (parameter.default !== undefined) return parameter.default;
  if (parameter.type === "boolean") return false;
  if (parameter.type === "number") return parameter.min ?? 0;
  if (parameter.type === "select") {
    const firstOption = parameter.options?.[0];
    if (typeof firstOption === "object") return firstOption.value;
    if (firstOption !== undefined) return firstOption;
  }
  return "";
}

export default function App() {
  const [savedLayout] = useState(() => loadLayoutConfig());
  const [activeView, setActiveView] = useState<"studio" | "qa">(() => savedLayout?.activeView ?? "studio");
  const [file, setFile] = useState<File | null>(null);
  const [parameterValues, setParameterValues] = useState<Record<string, ParameterValue>>(
    () => savedLayout?.parameterValues ?? {},
  );
  const [preview, setPreview] = useState<string | null>(null);
  const [extensions, setExtensions] = useState<ExtensionManifest[]>([]);
  const [selectedExt, setSelectedExt] = useState(() => savedLayout?.selectedExt ?? "");
  const [extensionDocs, setExtensionDocs] = useState<ExtensionDocs | null>(null);
  const [extensionDocsLoading, setExtensionDocsLoading] = useState(false);
  const [extensionDocsError, setExtensionDocsError] = useState("");
  const [extensionsError, setExtensionsError] = useState("");
  const [extensionsLoading, setExtensionsLoading] = useState(true);
  const [extensionSearch, setExtensionSearch] = useState("");
  const [extensionContextMenu, setExtensionContextMenu] = useState<ExtensionContextMenu | null>(null);
  const extensionMenuRef = useRef<HTMLDivElement>(null);
  const [fileError, setFileError] = useState("");
  const [backendStatus, setBackendStatus] = useState<BackendConnectionState>("checking");
  const [checkingBackend, setCheckingBackend] = useState(false);
  const [dependencyPrompt, setDependencyPrompt] = useState<{
    extension: ExtensionManifest;
    audit: ExtensionDependencyAudit;
  } | null>(null);
  const [installingDependencies, setInstallingDependencies] = useState(false);
  const [dependencyInstallError, setDependencyInstallError] = useState("");
  const [preflightError, setPreflightError] = useState("");
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => (
    savedLayout?.isSidebarOpen ?? (typeof window !== "undefined" ? window.innerWidth > 760 : true)
  ));
  const [isQaDrawerOpen, setIsQaDrawerOpen] = useState(false);
  const [isPropertiesOpen, setIsPropertiesOpen] = useState(() => savedLayout?.isPropertiesOpen ?? false);
  const [activeNode, setActiveNode] = useState<"input" | "output">("input");
  const [selectedNodeId, setSelectedNodeId] = useState<"source-image" | "3d-output">("source-image");
  const [isDragging, setIsDragging] = useState(false);
  const [canvasView, setCanvasView] = useState(
    () => savedLayout?.canvasView ?? { x: -10, y: 0, zoom: 0.65 },
  );
  const [flowViewport, setFlowViewport] = useState<Viewport | null>(
    () => savedLayout?.viewport ?? null,
  );
  const [isPanning, setIsPanning] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const inputTitleRef = useRef<HTMLDivElement>(null);
  const outputTitleRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const canvasAreaRef = useRef<HTMLElement>(null);
  const [inputBox, setInputBox] = useState<NodeBox>(
    () => savedLayout?.inputBox ?? { x: 30, y: 70, width: 280, height: 420 },
  );
  const [outputBox, setOutputBox] = useState<NodeBox>(
    () => savedLayout?.outputBox ?? { x: 390, y: 55, width: 430, height: 450 },
  );
  const { run, startRun, stop, clearRun, startError, isStarting } = useRun();

  const nodeCatalog: Array<{ id: string; number: string; label: string; category: string; x: number; y: number; ports: PolyFixNode["data"]["ports"] }> = [
    { id: "node_image_input", number: "01", label: "Source Image", category: "INPUT", x: 40, y: 70, ports: [{ id: "out_image", type: "image", label: "Image", direction: "out" }] },
    { id: "node_bg_remover", number: "01b", label: "Background Remover (rembg)", category: "PRE-PROCESS", x: 180, y: 70, ports: [{ id: "in_image", type: "image", label: "Input image", direction: "in" }, { id: "out_image", type: "image", label: "RGBA image", direction: "out" }] },
    { id: "node_spec_positive", number: "02", label: "Positive Specs", category: "CONDITIONING", x: 40, y: 330, ports: [{ id: "out_positive_spec", type: "spec", label: "Positive spec", direction: "out" }] },
    { id: "node_spec_negative", number: "03", label: "Negative Constraints", category: "CONDITIONING", x: 40, y: 470, ports: [{ id: "out_negative_rules", type: "rules", label: "Negative rules", direction: "out" }] },
    { id: "node_ai_generator", number: "04", label: "3D AI Generator", category: "AI MODEL", x: 330, y: 220, ports: [{ id: "in_image", type: "image", label: "Image", direction: "in" }, { id: "in_spec", type: "spec", label: "Positive specs", direction: "in" }, { id: "out_raw_mesh", type: "raw_mesh", label: "Raw mesh", direction: "out" }] },
    { id: "node_audit_curvature", number: "05", label: "Geometry Audit", category: "CORE / σ²", x: 620, y: 220, ports: [{ id: "in_raw_mesh", type: "raw_mesh", label: "Raw mesh", direction: "in" }, { id: "out_raw_mesh", type: "raw_mesh", label: "Raw mesh", direction: "out" }, { id: "out_audit_data", type: "audit_data", label: "Audit data", direction: "out" }] },
    { id: "node_retopology_instant", number: "06", label: "Quad Retopology", category: "CORE / INSTANT MESHES", x: 900, y: 220, ports: [{ id: "in_raw_mesh", type: "raw_mesh", label: "Raw mesh", direction: "in" }, { id: "in_audit_data", type: "audit_data", label: "Audit data", direction: "in" }, { id: "out_quad_mesh", type: "quad_mesh", label: "Quad mesh", direction: "out" }] },
    { id: "node_bake_pbr", number: "07", label: "UV & PBR Bake", category: "BLENDER / HEADLESS", x: 1180, y: 220, ports: [{ id: "in_raw_mesh", type: "raw_mesh", label: "High-poly mesh", direction: "in" }, { id: "in_quad_mesh", type: "quad_mesh", label: "Low-poly mesh", direction: "in" }, { id: "out_baked_mesh", type: "baked_mesh", label: "Baked mesh", direction: "out" }] },
    { id: "node_gar_verifier", number: "08", label: "GAR Verifier & Repair", category: "QUALITY / 5-AXIS", x: 1460, y: 220, ports: [{ id: "in_baked_mesh", type: "baked_mesh", label: "Baked mesh", direction: "in" }, { id: "in_raw_mesh", type: "raw_mesh", label: "Raw mesh", direction: "in" }, { id: "in_rules", type: "rules", label: "Negative rules", direction: "in" }, { id: "out_verified_mesh", type: "verified_mesh", label: "Verified mesh", direction: "out" }, { id: "out_metrics", type: "metrics", label: "GAR metrics", direction: "out" }] },
    { id: "node_3d_viewport", number: "09", label: "3D Output Viewport", category: "OUTPUT", x: 1740, y: 220, ports: [{ id: "in_verified_mesh", type: "verified_mesh", label: "Verified mesh", direction: "in" }] },
    { id: "node_heatmap_viewer", number: "10", label: "Spatial Error Heatmap", category: "DIAGNOSTIC", x: 1740, y: 480, ports: [{ id: "in_metrics", type: "metrics", label: "GAR metrics", direction: "in" }] },
  ];

  const initialNodes: PolyFixNode[] = nodeCatalog.map((node) => ({
    id: node.id,
    type: node.id === "node_bg_remover" ? "rembg" : "polyfix",
    position: { x: node.x, y: node.y },
    data: {
      label: node.label,
      nodeNumber: node.number,
      category: node.category,
      status: "idle",
      progress: 0,
      params: node.id === "node_spec_positive"
        ? { prompt: "", targetQuads: 5000, style: "PBR Prop" }
        : node.id === "node_spec_negative"
          ? { negativePrompt: "", maxHausdorff: 0.01, disallowUvOverlap: true }
          : {},
      ports: node.ports,
      preview: null,
      cacheToken: node.id === "node_image_input" && file ? `${file.name}-${file.size}` : undefined,
      imageFile: node.id === "node_bg_remover" ? file : undefined,
      onDataChange: node.id === "node_bg_remover"
        ? (nodeId: string, changes: Record<string, unknown>) => {
            setFlowNodes((current) => current.map((item) => (
              item.id === nodeId ? { ...item, data: { ...item.data, ...changes } } : item
            )));
          }
        : undefined,
      onChooseImage: () => fileInput.current?.click(),
      onDropImage: handleDrop,
    },
  }));

  const initialEdges: Edge[] = [
    { id: "image-generator", source: "node_image_input", target: "node_ai_generator", sourceHandle: "out_image", targetHandle: "in_image", type: "default" },
    { id: "positive-generator", source: "node_spec_positive", target: "node_ai_generator", sourceHandle: "out_positive_spec", targetHandle: "in_spec", type: "default" },
    { id: "negative-gar", source: "node_spec_negative", target: "node_gar_verifier", sourceHandle: "out_negative_rules", targetHandle: "in_rules", type: "default" },
    { id: "generator-audit", source: "node_ai_generator", target: "node_audit_curvature", sourceHandle: "out_raw_mesh", targetHandle: "in_raw_mesh", type: "default" },
    { id: "audit-retopo-mesh", source: "node_audit_curvature", target: "node_retopology_instant", sourceHandle: "out_raw_mesh", targetHandle: "in_raw_mesh", type: "default" },
    { id: "audit-retopo-data", source: "node_audit_curvature", target: "node_retopology_instant", sourceHandle: "out_audit_data", targetHandle: "in_audit_data", type: "default" },
    { id: "retopo-bake", source: "node_retopology_instant", target: "node_bake_pbr", sourceHandle: "out_quad_mesh", targetHandle: "in_quad_mesh", type: "default" },
    { id: "audit-bake", source: "node_audit_curvature", target: "node_bake_pbr", sourceHandle: "out_raw_mesh", targetHandle: "in_raw_mesh", type: "default" },
    { id: "bake-gar", source: "node_bake_pbr", target: "node_gar_verifier", sourceHandle: "out_baked_mesh", targetHandle: "in_baked_mesh", type: "default" },
    { id: "audit-gar", source: "node_audit_curvature", target: "node_gar_verifier", sourceHandle: "out_raw_mesh", targetHandle: "in_raw_mesh", type: "default" },
    { id: "gar-output", source: "node_gar_verifier", target: "node_3d_viewport", sourceHandle: "out_verified_mesh", targetHandle: "in_verified_mesh", type: "default" },
    { id: "gar-heatmap", source: "node_gar_verifier", target: "node_heatmap_viewer", sourceHandle: "out_metrics", targetHandle: "in_metrics", type: "default" },
  ].map((edge) => ({
    ...edge,
    style: {
      stroke: edge.sourceHandle?.includes("metrics") || edge.targetHandle?.includes("metrics")
        ? "#10b981"
        : edge.sourceHandle?.includes("spec") || edge.sourceHandle?.includes("rules") || edge.sourceHandle?.includes("audit")
          ? "#a855f7"
          : edge.sourceHandle?.includes("image")
            ? "#f59e0b"
            : "#06b6d4",
      strokeWidth: 2.5,
    },
  }));

  const restoredNodes: PolyFixNode[] | null = savedLayout?.nodes?.length
    ? savedLayout.nodes.map((saved) => ({
        id: saved.id,
        type: saved.type === "rembg" ? "rembg" : "polyfix",
        position: saved.position,
        data: {
          label: saved.data.label,
          nodeNumber: saved.data.nodeNumber,
          category: saved.data.category,
          status: saved.data.isBypassed ? "bypassed" : "idle",
          progress: 0,
          params: saved.data.params ?? {},
          ports: saved.data.ports ?? [],
          isBypassed: saved.data.isBypassed,
          isMuted: saved.data.isMuted,
          preview: null,
          imageFile: saved.type === "rembg" ? file : undefined,
          onDataChange: saved.type === "rembg"
            ? (nodeId: string, changes: Record<string, unknown>) => {
                setFlowNodes((current) => current.map((item) => (
                  item.id === nodeId ? { ...item, data: { ...item.data, ...changes } } : item
                )));
              }
            : undefined,
          onChooseImage: () => fileInput.current?.click(),
          onDropImage: handleDrop,
        },
      }))
    : null;

  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<PolyFixNode>(restoredNodes ?? initialNodes);
  const [flowEdges, setFlowEdges, onFlowEdgesChange] = useEdgesState(
    savedLayout?.edges ? savedLayout.edges : initialEdges,
  );
  const [edgeContextMenu, setEdgeContextMenu] = useState<EdgeContextMenu | null>(null);
  const polyfixFlowRef = useRef<HTMLDivElement>(null);
  const edgeMenuRef = useRef<HTMLDivElement>(null);
  const handleFlowConnect = useCallback(
    (edge: Edge) => setFlowEdges((current) => addEdge(edge, current)),
    [setFlowEdges],
  );

  const beginNodePointer = (
    event: ReactPointerEvent<HTMLDivElement>,
    node: "input" | "output",
    mode: "drag" | "resize",
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const canvas = canvasRef.current;
    if (!canvas) return;

    const setBox = node === "input" ? setInputBox : setOutputBox;
    const getBox = () => node === "input" ? inputBox : outputBox;
    const startBox = getBox();
    const startX = event.clientX;
    const startY = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);

    const handleMove = (moveEvent: PointerEvent) => {
      const dx = (moveEvent.clientX - startX) / canvasView.zoom;
      const dy = (moveEvent.clientY - startY) / canvasView.zoom;
      if (mode === "drag") {
        setBox({
          ...startBox,
          x: startBox.x + dx,
          y: startBox.y + dy,
        });
      } else {
        setBox({
          ...startBox,
          width: Math.max(220, startBox.width + dx),
          height: Math.max(330, startBox.height + dy),
        });
      }
    };

    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const loadExtensions = useCallback(async () => {
    setExtensionsError("");
    setExtensionsLoading(true);
    try {
      const list = await fetchInstalledModels();
      setExtensions(list);
      setSelectedExt((current) =>
        list.some((extension) => extension.id === current) ? current : list[0]?.id ?? "",
      );
    } catch (error) {
      setExtensionsError(error instanceof Error ? error.message : "Could not load installed models.");
    } finally {
      setExtensionsLoading(false);
    }
  }, []);

  const auditExtension = useCallback(async (extension: ExtensionManifest) => {
    try {
      const audit = await checkExtensionDeps(extension.id);
      if (!audit.is_ready) {
        setDependencyInstallError("");
        setDependencyPrompt({ extension, audit });
      }
      return audit;
    } catch (error) {
      setDependencyInstallError(error instanceof Error ? error.message : "Could not audit dependencies.");
      return null;
    }
  }, []);

  const installPromptDependencies = async () => {
    if (!dependencyPrompt) return;
    setInstallingDependencies(true);
    setDependencyInstallError("");
    try {
      const audit = await installExtensionDeps(dependencyPrompt.extension.id);
      await loadExtensions();
      if (audit.install_status === "failed") {
        setDependencyInstallError(audit.install_error || "Dependency installation failed.");
        setDependencyPrompt((current) => current ? { ...current, audit } : current);
      } else if (audit.is_ready) {
        setDependencyPrompt(null);
      } else {
        setDependencyPrompt((current) => current ? { ...current, audit } : current);
      }
    } catch (error) {
      setDependencyInstallError(error instanceof Error ? error.message : "Could not install dependencies.");
    } finally {
      setInstallingDependencies(false);
    }
  };

  const {
    downloadTasks,
    startInstall,
    cancelInstall,
    error: downloadError,
  } = useDownloads((task) => {
    void (async () => {
      await loadExtensions();
      const list = await fetchInstalledModels();
      const extension = list.find((candidate) =>
        task.name.toLowerCase() === candidate.name.toLowerCase()
        || (candidate.source_url && task.url.includes(candidate.source_url.replace("https://huggingface.co/", "")))
        || task.url.toLowerCase().includes(candidate.id.toLowerCase()),
      );
      if (extension) await auditExtension(extension);
    })();
  });

  const deleteExtension = async (extension: ExtensionManifest) => {
    if (!window.confirm("Delete model " + extension.name + "?")) return;
    try {
      await deleteExtensionApi(extension.id);
      if (selectedExt === extension.id) setSelectedExt("");
      await loadExtensions();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not remove the model.";
      setExtensionsError(message);
      alert(`Error deleting model: ${message}`);
    }
  };

  const retryConnection = async () => {
    setCheckingBackend(true);
    setBackendStatus("checking");
    const status = await checkBackendConnection();
    setBackendStatus(status);
    setCheckingBackend(false);
  };

  useEffect(() => {
    fetchInstalledModels()
      .then((list) => {
        setExtensions(list);
        setSelectedExt((current) =>
          list.some((extension) => extension.id === current) ? current : list[0]?.id ?? "",
        );
        setExtensionsLoading(false);
      })
      .catch((error: unknown) => {
        setExtensionsError(error instanceof Error ? error.message : "Could not load installed models.");
        setExtensionsLoading(false);
      });

    checkBackendConnection().then((status) => {
      setBackendStatus(status);
      setCheckingBackend(false);
    });
  }, []);

  useEffect(() => {
    clearRun();
  }, [selectedExt, clearRun]);

  useEffect(() => {
    if (!selectedExt) {
      setExtensionDocs(null);
      setExtensionDocsError("");
      return;
    }
    let cancelled = false;
    setExtensionDocsLoading(true);
    setExtensionDocsError("");
    fetchExtensionDocs(selectedExt)
      .then((docs) => {
        if (cancelled) return;
        setExtensionDocs(docs);
        setParameterValues((current) => {
          const next = { ...current };
          Object.entries(docs.recommended_params).forEach(([name, value]) => {
            if (next[name] === undefined) next[name] = value;
          });
          return next;
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setExtensionDocs(null);
        setExtensionDocsError(error instanceof Error ? error.message : "Could not load documentation.");
      })
      .finally(() => {
        if (!cancelled) setExtensionDocsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedExt]);

  useEffect(() => {
    if (!edgeContextMenu) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEdgeContextMenu(null);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (!edgeMenuRef.current?.contains(event.target as Node)) setEdgeContextMenu(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [edgeContextMenu]);

  useEffect(() => {
    if (!extensionContextMenu) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExtensionContextMenu(null);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (!extensionMenuRef.current?.contains(event.target as Node)) setExtensionContextMenu(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [extensionContextMenu]);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const selectFile = (nextFile?: File | null) => {
    if (!nextFile) return;
    const validationError = validateImageFile(nextFile);
    if (validationError) {
      setFileError(validationError);
      return;
    }

    if (file && (run?.status === "completed" || run?.status === "starting" || run?.status === "processing")) {
      const confirmed = window.confirm("A generation run is active or has completed. Replace the current image?");
      if (!confirmed) return;
    }

    setFileError("");
    if (preview) URL.revokeObjectURL(preview);
    setFile(nextFile);
    setPreview(URL.createObjectURL(nextFile));
  };

  const clearImage = () => {
    if (!file) return;
    if (run?.status === "completed" || run?.status === "starting" || run?.status === "processing") {
      const confirmed = window.confirm("A generation run is active or has completed. Clear the current image?");
      if (!confirmed) return;
    }
    if (preview) URL.revokeObjectURL(preview);
    setFile(null);
    setPreview(null);
    setFileError("");
  };

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    selectFile(event.dataTransfer.files[0]);
  }

  const handleNodeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, node: "input" | "output") => {
    if (event.key === "Tab") {
      setActiveNode(node);
      setSelectedNodeId(node === "input" ? "source-image" : "3d-output");
      return;
    }
    if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const nextNode = node === "input" ? "output" : "input";
      setActiveNode(nextNode);
      setSelectedNodeId(nextNode === "input" ? "source-image" : "3d-output");
      (nextNode === "input" ? inputTitleRef : outputTitleRef).current?.focus();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      setActiveNode(node);
      setSelectedNodeId(node === "input" ? "source-image" : "3d-output");
      if (node === "input") fileInput.current?.click();
      else setIsPropertiesOpen(true);
    }
  };

  const selectedExtension = extensions.find((extension) => extension.id === selectedExt);
  const isWorking = run?.status === "starting" || run?.status === "processing";
  const uploadedImage = file;
  const isGenerating = isStarting || isWorking;
  const activeError = preflightError || startError || (run?.status === "failed" ? null : run?.error);
  const runLabel = isStarting
    ? "Starting"
    : run?.status === "processing" || run?.status === "starting"
      ? "Processing"
      : run?.status === "completed"
        ? "Completed"
        : run?.status === "failed"
          ? "Failed"
          : "Idle";
  const runBadgeClass = isStarting ? "starting" : run?.status ?? "idle";
  const generateAndInspect = async () => {
    if (!uploadedImage || !selectedExtension || isGenerating) return;
    setPreflightError("");

    const graphErrors = validateNodeGraph(flowNodes, flowEdges);
    if (graphErrors.length > 0) {
      const message = graphErrors.map((error) => error.message).join(" ");
      const failingIds = new Set(graphErrors.map((error) => error.nodeId));
      setPreflightError(message);
      setFlowNodes((current) => current.map((node) => (
        failingIds.has(node.id)
          ? { ...node, data: { ...node.data, status: "failed", errorMessage: message } }
          : node
      )));
      return;
    }

    try {
      const preflight = await checkNodePreflight(selectedExtension.id) as {
        ready?: boolean;
        valid?: boolean;
        message?: string;
        dependencies?: {
          missing_packages?: string[];
          is_ready?: boolean;
          error?: string;
        };
        signature?: {
          valid?: boolean;
          message?: string;
        };
      };
      const isReady = preflight.ready ?? preflight.valid ?? false;
      if (!isReady) {
        const missingPackages = preflight.dependencies?.missing_packages ?? [];
        const missing = missingPackages.length
          ? `Missing packages: ${missingPackages.join(", ")}.`
          : "";
        const dependencyMessage = preflight.dependencies
          ? (preflight.dependencies.is_ready
              ? ""
              : missing || preflight.dependencies.error || "Model dependencies are not ready.")
          : "";
        const signatureMessage = preflight.signature
          ? (preflight.signature.valid ? "" : preflight.signature.message ?? "")
          : (preflight.message ?? "");
        const message = [dependencyMessage, signatureMessage].filter(Boolean).join(" ");
        setPreflightError(message || "This node is not ready to execute.");
        setFlowNodes((current) => current.map((node) => (
          node.id === "node_ai_generator" || node.id.startsWith("node_ai_generator_") || node.data.nodeNumber === "04"
            ? { ...node, data: { ...node.data, status: "warning", errorMessage: message || "This node is not ready to execute." } }
            : node
        )));
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not validate this node.";
      setPreflightError(message);
      setFlowNodes((current) => current.map((node) => (
        node.id === "node_ai_generator"
          ? { ...node, data: { ...node.data, status: "warning", errorMessage: message } }
          : node
      )));
      return;
    }

    setActiveView("qa");
    const resolved = resolveGraphExecution(flowNodes, flowEdges, selectedExtension.id);
    const aggregatedParams: Record<string, ParameterValue> = {
      ...parameterValues,
      ...resolved.nodeOverrides as Record<string, ParameterValue>,
    };
    void startRun(selectedExtension.id, uploadedImage, aggregatedParams);
  };

  useEffect(() => {
    const parameters = selectedExtension?.parameters ?? {};
    const defaults = Object.fromEntries(
      Object.entries(parameters).map(([name, parameter]) => [name, getParameterDefault(parameter)]),
    );
    queueMicrotask(() => setParameterValues((current) => ({ ...defaults, ...current })));
  }, [selectedExtension]);

  const updateParameter = (name: string, value: ParameterValue) => {
    setParameterValues((current) => ({ ...current, [name]: value }));
  };

  useEffect(() => {
    const generatorProgress = isStarting ? 0 : run?.progress ?? 0;
    setFlowNodes((current) => current.map((node) => {
      const isImage = node.id === "node_image_input" || node.id.startsWith("node_image_input_");
      const isGenerator = node.id === "node_ai_generator" || node.id.startsWith("node_ai_generator_") || node.data.nodeNumber === "04";
      const isOutput = node.id === "node_3d_viewport";
      const isAudit = node.id === "node_audit_curvature";
      const isRetopo = node.id === "node_retopology_instant";
      const isBake = node.id === "node_bake_pbr";
      const isGar = node.id === "node_gar_verifier";
      const isHeatmap = node.id === "node_heatmap_viewer";
      const isProcessing = run?.status === "processing" || run?.status === "starting";

      let status: PolyFixNodeStatus = node.data.status;
      let progress = status === "idle" || status === "queued" ? 0 : node.data.progress;

      if (!run || run.status === "idle") {
        status = isImage && file ? "queued" : "idle";
        progress = isImage && file ? 100 : 0;
        if (isImage && file) status = "completed";
      } else if (run.status === "failed") {
        if (isImage && file) { status = "completed"; progress = 100; }
        else {
          const failingNode =
            generatorProgress < 20 ? isGenerator
              : generatorProgress < 40 ? isAudit
                : generatorProgress < 60 ? isRetopo
                  : generatorProgress < 80 ? isBake
                    : isGar;
          if (failingNode) { status = "failed"; progress = generatorProgress; }
        }
        if (isOutput) { status = "idle"; progress = 0; }
      } else if (run.status === "completed") {
        status = ["node_image_input", "node_ai_generator", "node_audit_curvature", "node_retopology_instant", "node_bake_pbr", "node_gar_verifier", "node_3d_viewport", "node_heatmap_viewer"].includes(node.id)
          ? "completed" : node.data.status;
        progress = status === "completed" ? 100 : progress;
      } else if (isProcessing) {
        if (isImage) { status = "completed"; progress = 100; }
        if (isGenerator) {
          status = generatorProgress < 20 ? "executing" : "completed";
          progress = generatorProgress < 20 ? generatorProgress : 100;
        }
        if (isAudit) {
          status = generatorProgress < 20 ? "idle" : generatorProgress < 40 ? "executing" : "completed";
          progress = status === "idle" ? 0 : status === "executing" ? generatorProgress : 100;
        }
        if (isRetopo) {
          status = generatorProgress < 40 ? "idle" : generatorProgress < 60 ? "executing" : "completed";
          progress = status === "idle" ? 0 : status === "executing" ? generatorProgress : 100;
        }
        if (isBake) {
          status = generatorProgress < 60 ? "idle" : generatorProgress < 80 ? "executing" : "completed";
          progress = status === "idle" ? 0 : status === "executing" ? generatorProgress : 100;
        }
        if (isGar || isHeatmap) {
          status = generatorProgress < 80 ? "idle" : generatorProgress < 100 ? "executing" : "completed";
          progress = status === "idle" ? 0 : status === "executing" ? generatorProgress : 100;
        }
        if (isOutput) {
          status = generatorProgress >= 100 ? "completed" : "idle";
          progress = status === "completed" ? 100 : 0;
        }
      }

      const isConditionNode = node.id === "node_spec_positive" || node.id === "node_spec_negative";
      return {
        ...node,
        data: {
          ...node.data,
          preview: isImage ? preview : node.data.preview,
          imageFile: node.type === "rembg" ? file : node.data.imageFile,
          onDataChange: node.type === "rembg"
            ? (nodeId: string, changes: Record<string, unknown>) => {
                setFlowNodes((current) => current.map((item) => (
                  item.id === nodeId ? { ...item, data: { ...item.data, ...changes } } : item
                )));
              }
            : node.data.onDataChange,
          cacheToken: isImage && file ? `${file.name}-${file.size}` : node.data.cacheToken,
          status,
          progress,
          extensions: isGenerator ? extensions.map((extension) => ({
            id: extension.id,
            name: extension.name,
            is_ready: extension.is_ready,
            status_message: extension.status_message,
            requires_gpu: extension.requires_gpu,
          })) : node.data.extensions,
          selectedExtensionId: isGenerator ? selectedExt : node.data.selectedExtensionId,
          onSelectExtension: isGenerator ? setSelectedExt : node.data.onSelectExtension,
          onUpdateParams: isConditionNode
            ? (params: Record<string, unknown>) => {
                setFlowNodes((current) => current.map((item) => (
                  item.id === node.id
                    ? { ...item, data: { ...item.data, params } }
                    : item
                )));
              }
            : node.data.onUpdateParams,
          runStatus: isOutput ? run?.status ?? "idle" : node.data.runStatus,
          onRetry: isOutput && file && selectedExtension && !isGenerating
            ? generateAndInspect
            : node.data.onRetry,
          errorMessage: isGenerator && run?.status === "failed" ? run.error ?? undefined : node.data.errorMessage,
          resultUrl: isOutput && run?.status === "completed" && run.id ? resultUrl(run.id) : null,
        },
      };
    }));
    setFlowEdges((current) => current.map((edge) => ({
      ...edge,
      animated: edge.source === "node_ai_generator" && (run?.status === "processing" || run?.status === "starting"),
    })));
  }, [
    file,
    preview,
    run,
    isStarting,
    extensions,
    selectedExt,
    parameterValues,
    selectedExtension,
    isGenerating,
    setFlowEdges,
    setFlowNodes,
  ]);

  const zoomCanvas = (nextZoom: number, clientX?: number, clientY?: number) => {
    const zoom = Math.max(0.35, Math.min(2, nextZoom));
    const rect = canvasAreaRef.current?.getBoundingClientRect();
    if (!rect || clientX === undefined || clientY === undefined) {
      setCanvasView((current) => ({ ...current, zoom }));
      return;
    }

    const localX = clientX - rect.left;
    const localY = clientY - rect.top - 76;
    setCanvasView((current) => {
      const worldX = (localX - current.x) / current.zoom;
      const worldY = (localY - current.y) / current.zoom;
      return {
        zoom,
        x: localX - worldX * zoom,
        y: localY - worldY * zoom,
      };
    });
  };

  const resetCanvasView = () => {
    setCanvasView({ x: -10, y: 0, zoom: 0.65 });
    setInputBox({ x: 30, y: 70, width: 280, height: 420 });
    setOutputBox({ x: 390, y: 55, width: 430, height: 450 });
  };

  const beginCanvasPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || window.matchMedia("(max-width: 760px)").matches) return;
    if (event.target !== event.currentTarget && event.target !== canvasRef.current?.querySelector(".node-wires")) return;

    event.preventDefault();
    setIsPanning(true);
    const startX = event.clientX;
    const startY = event.clientY;
    const startView = canvasView;
    event.currentTarget.setPointerCapture(event.pointerId);

    const handleMove = (moveEvent: PointerEvent) => {
      setCanvasView({
        ...startView,
        x: startView.x + moveEvent.clientX - startX,
        y: startView.y + moveEvent.clientY - startY,
      });
    };
    const handleUp = () => {
      setIsPanning(false);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const resetLayout = () => {
    clearLayoutConfig();
    setActiveView("studio");
    setIsSidebarOpen(typeof window !== "undefined" ? window.innerWidth > 760 : true);
    setIsPropertiesOpen(false);
    setFlowNodes(initialNodes);
    setFlowEdges(initialEdges);
    setFlowViewport(null);
    setCanvasView({ x: -10, y: 0, zoom: 0.65 });
    setInputBox({ x: 30, y: 70, width: 280, height: 420 });
    setOutputBox({ x: 390, y: 55, width: 430, height: 450 });
  };

  const latestLayoutRef = useRef<SavedLayoutConfig | null>(null);
  latestLayoutRef.current = {
    version: 1,
    activeView,
    isSidebarOpen,
    isPropertiesOpen,
    selectedExt,
    parameterValues,
    nodes: serializeFlowNodes(flowNodes),
    edges: serializeFlowEdges(flowEdges),
    viewport: flowViewport,
    canvasView,
    inputBox,
    outputBox,
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (latestLayoutRef.current) {
        saveLayoutConfig(latestLayoutRef.current);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    activeView,
    isSidebarOpen,
    isPropertiesOpen,
    selectedExt,
    parameterValues,
    flowNodes,
    flowEdges,
    flowViewport,
    canvasView,
    inputBox,
    outputBox,
  ]);

  useEffect(() => {
    const flushLayout = () => {
      if (latestLayoutRef.current) {
        saveLayoutConfig(latestLayoutRef.current);
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushLayout();
    };
    window.addEventListener("beforeunload", flushLayout);
    window.addEventListener("pagehide", flushLayout);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      flushLayout();
      window.removeEventListener("beforeunload", flushLayout);
      window.removeEventListener("pagehide", flushLayout);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!isQaDrawerOpen && !(isSidebarOpen && window.innerWidth <= 760)) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (activeView === "qa") setIsQaDrawerOpen(false);
      else if (window.innerWidth <= 760) setIsSidebarOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeView, isQaDrawerOpen, isSidebarOpen]);

  return (
    <main className="app-shell flex flex-col h-screen w-screen overflow-hidden bg-[#0d0e12]">
      <Header
        activeView={activeView}
        setActiveView={(view) => {
          setActiveView(view);
          setIsQaDrawerOpen(false);
        }}
        backendStatus={backendStatus}
        checkingBackend={checkingBackend}
        processing={isWorking || isStarting}
        onRetryConnection={() => void retryConnection()}
        isSidebarOpen={activeView === "studio" ? isSidebarOpen : isQaDrawerOpen}
        onToggleSidebar={() => {
          if (activeView === "studio") setIsSidebarOpen((open) => !open);
          else setIsQaDrawerOpen((open) => !open);
        }}
        onOpenProperties={() => setIsPropertiesOpen(true)}
      />

      {activeView === "qa" ? (
        <>
          {isQaDrawerOpen && (
            <button
              type="button"
              className="sidebar-backdrop open"
              aria-label="Close navigation menu"
              onClick={() => setIsQaDrawerOpen(false)}
            />
          )}
          <aside
            className={`qa-nav-drawer ${isQaDrawerOpen ? "open" : ""}`}
            aria-label="Workspace navigation"
          >
            <div className="panel-heading">
              <div>
                <span className="eyebrow">Navigation</span>
                <h2>Workspace</h2>
              </div>
              <button
                type="button"
                className="close-sidebar visible"
                onClick={() => setIsQaDrawerOpen(false)}
                aria-label="Close navigation menu"
              >
                ×
              </button>
            </div>
            <nav className="qa-drawer-links">
              <button
                type="button"
                className="qa-drawer-link"
                onClick={() => {
                  setActiveView("studio");
                  setIsQaDrawerOpen(false);
                }}
              >
                <span>Node Studio</span>
                <small>Phase 1</small>
              </button>
              <button
                type="button"
                className="qa-drawer-link active"
                onClick={() => setIsQaDrawerOpen(false)}
              >
                <span>3D QA Dashboard</span>
                <small>Phase 2</small>
              </button>
            </nav>
            <div className="qa-drawer-footer">
              <button
                type="button"
                className="qa-drawer-action"
                onClick={() => {
                  void loadExtensions();
                  setIsQaDrawerOpen(false);
                }}
              >
                ↻ Refresh Installed Models
              </button>
              <button
                type="button"
                className="qa-drawer-action"
                onClick={() => {
                  resetLayout();
                  setIsQaDrawerOpen(false);
                }}
              >
                ↺ Reset UI Layout
              </button>
              <button
                type="button"
                className="qa-drawer-action"
                onClick={() => {
                  void retryConnection();
                  setIsQaDrawerOpen(false);
                }}
              >
                Check Backend Connection
              </button>
            </div>
          </aside>
          <GenerationDashboard
            run={run}
            startError={startError}
            selectedExtension={selectedExtension}
            file={uploadedImage}
            parameterValues={parameterValues}
            onRetry={() => uploadedImage && selectedExtension && void startRun(
              selectedExtension.id,
              uploadedImage,
              parameterValues,
            )}
            onStudio={() => setActiveView("studio")}
          />
        </>
      ) : (
      <div className={`workspace ${isSidebarOpen ? "" : "sidebar-collapsed"}`}>
        {isSidebarOpen && (
          <button
            type="button"
            className="sidebar-backdrop open"
            aria-label="Close extensions sidebar"
            onClick={() => setIsSidebarOpen(false)}
          />
        )}
        <aside className={`extensions-panel ${isSidebarOpen ? "open" : "collapsed"}`}>
          <div className="panel-heading">
            <div>
              <span className="eyebrow">AI Assets</span>
              <h2>Models Installed</h2>
            </div>
            <div className="extensions-heading-actions">
              <button
                type="button"
                className="extension-refresh"
                title="Refresh installed models"
                onClick={() => void loadExtensions()}
              >
                ↻
              </button>
              <span className="count">{extensions.length}</span>
              <button
                type="button"
                className="close-sidebar"
                onClick={() => setIsSidebarOpen(false)}
                aria-label="Close installed models sidebar"
              >
                ×
              </button>
            </div>
          </div>

          <label className="extension-search">
            <span className="sr-only">Search installed models</span>
            <input
              value={extensionSearch}
              onChange={(event) => setExtensionSearch(event.target.value)}
              placeholder="Search installed models..."
            />
          </label>

          {(downloadTasks.length > 0 || downloadError) && (
            <div className="extension-downloads">
              <div className="download-section-title">
                <span>Downloading Models</span>
                {downloadTasks.some((task) => task.status === "downloading") && <span className="downloading-dot" />}
              </div>
              {downloadError && <div className="download-task-error">{downloadError}</div>}
              {downloadTasks.map((task) => (
                <article className={`download-task-card ${task.status}`} key={task.task_id}>
                  <div className="download-task-header">
                    <span className={`source-icon ${task.source_type}`}>
                      {task.source_type === "github" ? "GH" : task.source_type === "huggingface" ? "HF" : "ZIP"}
                    </span>
                    <div>
                      <strong>{task.name}</strong>
                      <small title={task.url}>{task.url}</small>
                    </div>
                  </div>
                  {task.status === "downloading" && (
                    <>
                      <div className="download-task-progress">
                        <span>{task.status_text}</span>
                        <strong>{task.progress}%</strong>
                      </div>
                      <div className="download-task-track">
                        <div style={{ width: `${task.progress}%` }} />
                      </div>
                      {task.speed > 0 && (
                        <small className="download-speed">
                          {(task.speed / 1024 / 1024).toFixed(1)} MB/s
                        </small>
                      )}
                    </>
                  )}
                  {task.status === "failed" && (
                    <div className="download-task-message error">Error: {task.error}</div>
                  )}
                  {task.status === "completed" && (
                    <div className="download-task-message success">
                      {task.notice || "Installation complete"}
                    </div>
                  )}
                  {task.status === "cancelled" && (
                    <div className="download-task-message">Download cancelled</div>
                  )}
                  {task.status === "downloading" && (
                    <button
                      type="button"
                      className="cancel-download"
                      onClick={() => void cancelInstall(task.task_id)}
                    >
                      Cancel
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}

          <div className="extension-list">
            {extensions
              .filter((extension) =>
                `${extension.name} ${extension.id} ${extension.type}`
                  .toLowerCase()
                  .includes(extensionSearch.trim().toLowerCase()),
              )
              .map((extension) => {
              const selected = extension.id === selectedExt;
              return (
                <div
                  className="extension-card-wrap"
                  key={extension.id}
                  onContextMenu={(event) => {
                    if (extension.removable === false) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const menuWidth = 190;
                    const menuHeight = 112;
                    setExtensionContextMenu({
                      extension,
                      x: Math.max(8, Math.min(window.innerWidth - menuWidth - 8, event.clientX)),
                      y: Math.max(8, Math.min(window.innerHeight - menuHeight - 8, event.clientY)),
                    });
                  }}
                >
                  <button
                    type="button"
                    className={`extension-card ${selected ? "selected" : ""}`}
                    onClick={() => {
                      setSelectedExt(extension.id);
                      setIsPropertiesOpen(true);
                      void auditExtension(extension);
                    }}
                  >
                    <span className="extension-icon"><CubeIcon /></span>
                    <span className="extension-copy">
                      <strong>{extension.name}</strong>
                      <small>v{extension.version} · {extension.type}</small>
                      {extension.storage_path && (
                        <small className="extension-storage-path" title={extension.storage_path}>
                          <span aria-hidden="true">📁</span> {extension.storage_path}
                        </small>
                      )}
                    </span>
                    {extension.is_ready
                      ? <span className={`extension-ready-badge ${extension.requires_gpu ? "gpu" : "demo"}`}>
                          {extension.requires_gpu ? "Ready (CUDA)" : "Demo Mode"}
                        </span>
                      : <span className="extension-ready-badge missing">Missing Dependencies / No CUDA</span>}
                  </button>
                </div>
              );
            })}
            {extensionsLoading && <div className="empty-state">Loading installed models...</div>}
            {!extensionsLoading && extensionsError && (
              <div className="empty-state extension-load-error">
                <span>{extensionsError}</span>
                <button type="button" onClick={() => void loadExtensions()}>Retry Loading Models</button>
              </div>
            )}
            {!extensionsLoading && extensionSearch.trim() && !extensions.some((extension) =>
              `${extension.name} ${extension.id} ${extension.type}`
                .toLowerCase()
                .includes(extensionSearch.trim().toLowerCase()),
            ) && (
              <div className="empty-state">No matching installed models</div>
            )}
            {!extensionsLoading && !extensionsError && extensions.length === 0 && (
              <div className="empty-state">No models installed</div>
            )}
          </div>
          {extensionContextMenu && (
            <div
              ref={extensionMenuRef}
              className="extension-context-menu"
              role="menu"
              aria-label={`Actions for ${extensionContextMenu.extension.name}`}
              style={{ left: extensionContextMenu.x, top: extensionContextMenu.y }}
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              <span className="extension-context-menu-title">{extensionContextMenu.extension.name}</span>
              <button
                type="button"
                role="menuitem"
                className="extension-context-delete"
                onClick={() => {
                  setExtensionContextMenu(null);
                  void deleteExtension(extensionContextMenu.extension);
                }}
              >
                🗑 Delete Model
              </button>
              <button
                type="button"
                role="menuitem"
                className="extension-context-cancel"
                onClick={() => setExtensionContextMenu(null)}
              >
                Cancel
              </button>
            </div>
          )}

          <InstallExtension
            onInstalled={() => void loadExtensions()}
            onStartInstall={startInstall}
          />
        </aside>

        <section
          ref={canvasAreaRef}
          className={`canvas-area ${isPanning ? "canvas-panning" : ""}`}
          onWheel={(event) => {
            event.preventDefault();
            const factor = event.deltaY > 0 ? 0.9 : 1.1;
            zoomCanvas(canvasView.zoom * factor, event.clientX, event.clientY);
          }}
        >
          <div className="canvas-toolbar">
            <div>
              <span className="eyebrow">Pipeline</span>
              <h1>{selectedExtension?.name ?? "Image to 3D"}</h1>
            </div>
            <div className="canvas-toolbar-actions">
              <button
                type="button"
                className="reset-layout-button"
                title="Reset node positions and UI layout to defaults"
                onClick={resetLayout}
              >
                ↺ Reset Layout
              </button>
              <span className={`run-badge ${runBadgeClass}`}>{runLabel}</span>
            </div>
          </div>

          <div
            ref={polyfixFlowRef}
            className="polyfix-reactflow"
            onClick={() => setEdgeContextMenu(null)}
          >
            <PolyFixCanvas
              nodes={flowNodes}
              edges={flowEdges}
              onNodesChange={(changes) => {
                const removedIds = new Set(
                  changes.filter((change) => change.type === "remove").map((change) => change.id),
                );
                if (removedIds.size > 0) {
                  setFlowEdges((current) => current.filter(
                    (edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target),
                  ));
                }
                onFlowNodesChange(changes);
              }}
              onEdgesChange={onFlowEdgesChange}
              onConnect={handleFlowConnect}
              onEdgeContextMenu={(event, edge) => {
                event.preventDefault();
                const bounds = polyfixFlowRef.current?.getBoundingClientRect();
                if (!bounds) return;
                const menuWidth = 190;
                const menuHeight = 112;
                const pointerX = event.clientX - bounds.left;
                const pointerY = event.clientY - bounds.top;
                setEdgeContextMenu({
                  edgeId: edge.id,
                  x: Math.max(8, Math.min(bounds.width - menuWidth - 8, pointerX)),
                  y: Math.max(8, Math.min(bounds.height - menuHeight - 8, pointerY)),
                });
              }}
              onAddNode={(template: PolyFixNodeTemplate, position) => {
                const duplicateId = `${template.id}_${Date.now()}`;
                setFlowNodes((current) => [
                  ...current,
                  {
                    id: duplicateId,
                    type: template.id === "node_bg_remover" ? "rembg" : "polyfix",
                    position,
                    data: {
                      label: template.label,
                      nodeNumber: template.number,
                      category: template.category,
                      status: "idle",
                      progress: 0,
                      params: template.id === "node_spec_positive"
                        ? { prompt: "", targetQuads: 5000, style: "PBR Prop" }
                        : template.id === "node_spec_negative"
                          ? { negativePrompt: "", maxHausdorff: 0.01, disallowUvOverlap: true }
                          : {},
                      ports: template.ports,
                      preview: null,
                      cacheToken: undefined,
                      imageFile: template.id === "node_bg_remover" ? file : undefined,
                      processedUrl: null,
                      onDataChange: template.id === "node_bg_remover"
                        ? (nodeId: string, changes: Record<string, unknown>) => {
                            setFlowNodes((current) => current.map((item) => (
                              item.id === nodeId ? { ...item, data: { ...item.data, ...changes } } : item
                            )));
                          }
                        : undefined,
                      onChooseImage: template.id === "node_image_input" ? () => fileInput.current?.click() : undefined,
                      onDropImage: template.id === "node_image_input" ? handleDrop : undefined,
                      extensions: template.id === "node_ai_generator"
                        ? extensions.map((extension) => ({
                            id: extension.id,
                            name: extension.name,
                            is_ready: extension.is_ready,
                            status_message: extension.status_message,
                            requires_gpu: extension.requires_gpu,
                          }))
                        : undefined,
                      selectedExtensionId: template.id === "node_ai_generator" ? selectedExt : undefined,
                      onSelectExtension: template.id === "node_ai_generator" ? setSelectedExt : undefined,
                    },
                  },
                ]);
              }}
              onDeleteNode={(nodeId) => {
                setFlowNodes((current) => current.filter((node) => node.id !== nodeId));
                setFlowEdges((current) => current.filter(
                  (edge) => edge.source !== nodeId && edge.target !== nodeId,
                ));
              }}
              onDuplicateNode={(targetNode) => {
                const duplicateId = `${targetNode.type}_${targetNode.id}_${Date.now()}`;
                setFlowNodes((current) => [
                  ...current,
                  {
                    ...targetNode,
                    id: duplicateId,
                    selected: false,
                    position: {
                      x: targetNode.position.x + 40,
                      y: targetNode.position.y + 40,
                    },
                    data: {
                      ...targetNode.data,
                      params: { ...targetNode.data.params },
                      ports: targetNode.data.ports.map((port) => ({ ...port })),
                      status: "idle",
                      progress: 0,
                    },
                  },
                ]);
              }}
              onToggleNodeBypass={(nodeId) => {
                setFlowNodes((current) => current.map((node) => (
                  node.id === nodeId
                    ? {
                        ...node,
                        data: {
                          ...node.data,
                          isBypassed: !node.data.isBypassed,
                          status: node.data.isBypassed ? "idle" : "bypassed",
                        },
                      }
                    : node
                )));
              }}
              initialViewport={flowViewport}
              onViewportChange={setFlowViewport}
            />
            {edgeContextMenu && (
              <div
                ref={edgeMenuRef}
                className="edge-context-menu"
                role="menu"
                aria-label="Connection options"
                style={{ left: edgeContextMenu.x, top: edgeContextMenu.y }}
                onClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.preventDefault()}
              >
                <span className="edge-context-menu-title">Connection</span>
                <button
                  type="button"
                  role="menuitem"
                  className="edge-context-delete"
                  onClick={() => {
                    setFlowEdges((edges) => edges.filter((item) => item.id !== edgeContextMenu.edgeId));
                    setEdgeContextMenu(null);
                  }}
                >
                  Delete connection
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="edge-context-cancel"
                  onClick={() => setEdgeContextMenu(null)}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          <div className="canvas-controls" aria-label="Canvas controls">
            <button type="button" title="Zoom out" onClick={() => zoomCanvas(canvasView.zoom / 1.15)}>−</button>
            <button type="button" title="Reset canvas" onClick={resetCanvasView}>{Math.round(canvasView.zoom * 100)}%</button>
            <button type="button" title="Zoom in" onClick={() => zoomCanvas(canvasView.zoom * 1.15)}>+</button>
          </div>

          <div
            className="canvas-grid"
            ref={canvasRef}
            onPointerDown={beginCanvasPan}
            style={{
              transform: `translate(${canvasView.x}px, ${canvasView.y}px) scale(${canvasView.zoom})`,
              transformOrigin: "0 0",
            }}
          >
            <svg className="node-wires" aria-hidden="true">
              <path
                d={`M ${inputBox.x + inputBox.width} ${inputBox.y + 210}
                    C ${inputBox.x + inputBox.width + 35} ${inputBox.y + 210},
                      ${outputBox.x - 35} ${outputBox.y + 210},
                      ${outputBox.x} ${outputBox.y + 210}`}
              />
              <circle cx={inputBox.x + inputBox.width} cy={inputBox.y + 210} r="5" />
              <circle cx={outputBox.x} cy={outputBox.y + 210} r="5" />
            </svg>

            <div
              className={`input-node workflow-node ${file ? "has-file" : ""}`}
              style={{ left: inputBox.x, top: inputBox.y, width: inputBox.width, height: inputBox.height }}
              onClick={() => setSelectedNodeId("source-image")}
            >
              <div
                ref={inputTitleRef}
                className={`node-title node-drag-handle node-keyboard-target ${activeNode === "input" ? "active-node" : ""}`}
                role="button"
                tabIndex={0}
                aria-label="Source image node. Press Enter to choose an image. Use arrow keys to move focus between workflow nodes."
                onPointerDown={(event) => {
                  setActiveNode("input");
                  setSelectedNodeId("source-image");
                  beginNodePointer(event, "input", "drag");
                }}
                onFocus={() => {
                  setActiveNode("input");
                  setSelectedNodeId("source-image");
                }}
                onKeyDown={(event) => handleNodeKeyDown(event, "input")}
              >
                <span className="node-number">01</span>
                <div><strong>Source image</strong><small>INPUT</small></div>
                <span className="drag-grip" aria-hidden="true">••<br />••</span>
              </div>
              <span className="flow-handle flow-handle-source" aria-hidden="true" title="Source handle" />
              <div
                className={`dropzone ${isDragging ? "dragging" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={preview ? "Replace source image" : "Choose a source image"}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    fileInput.current?.click();
                  }
                }}
                onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInput.current?.click()}
              >
                {preview ? (
                  <>
                    <img src={preview} alt="Selected source" />
                    <div className="image-overlay">
                      <strong>{file?.name}</strong>
                      <span>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : ""}</span>
                    </div>
                  </>
                ) : (
                  <div className="upload-empty">
                    <span className="upload-icon">↑</span>
                    <strong>Drop an image here</strong>
                    <small>PNG, JPG, JPEG or WEBP</small>
                  </div>
                )}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    selectFile(event.target.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                  hidden
                />
              </div>
              {fileError && <div className="upload-error" role="alert">{fileError}</div>}
              {preview && (
                <div className="image-actions">
                  <button type="button" className="replace-button" onClick={() => fileInput.current?.click()}>
                    Replace image
                  </button>
                  <button type="button" className="clear-image-button" onClick={clearImage}>
                    Clear Image
                  </button>
                </div>
              )}
              <div
                className="resize-handle"
                aria-label="Resize source node"
                onPointerDown={(event) => beginNodePointer(event, "input", "resize")}
              />
            </div>
            
            <div
              className={`output-node workflow-node ${run?.status === "completed" ? "has-output" : ""}`}
              style={{ left: outputBox.x, top: outputBox.y, width: outputBox.width, height: outputBox.height }}
              onClick={() => setSelectedNodeId("3d-output")}
            >
              <div
                ref={outputTitleRef}
                className={`node-title node-drag-handle node-keyboard-target ${activeNode === "output" ? "active-node" : ""}`}
                role="button"
                tabIndex={0}
                aria-label="3D output node. Press Enter to open extension properties. Use arrow keys to move focus between workflow nodes."
                onPointerDown={(event) => {
                  setActiveNode("output");
                  setSelectedNodeId("3d-output");
                  beginNodePointer(event, "output", "drag");
                }}
                onFocus={() => {
                  setActiveNode("output");
                  setSelectedNodeId("3d-output");
                }}
                onKeyDown={(event) => handleNodeKeyDown(event, "output")}
              >
                <span className="node-number">02</span>
                <div><strong>3D output</strong><small>GLB PREVIEW</small></div>
                <span className="drag-grip" aria-hidden="true">••<br />••</span>
              </div>
              <span className="flow-handle flow-handle-target" aria-hidden="true" title="Target handle" />
              <div className="output-stage">
                {run?.status === "failed" ? (
                  <div className="generation-failed" role="alert">
                    <strong>Generation Failed</strong>
                    <p>{run.error || "Generation could not be completed. Check your settings and try again."}</p>
                    <button
                      type="button"
                      className="retry-generation-button"
                      disabled={!selectedExtension || !uploadedImage || isGenerating}
                      onClick={generateAndInspect}
                    >
                      {isStarting ? "Starting…" : "Retry Generation"}
                    </button>
                  </div>
                ) : run?.status === "completed" ? (
                  <>
                    <Viewer url={resultUrl(run.id)} />
                    <a className="download-button" href={resultUrl(run.id)} download={`model-${run.id}.glb`}>
                      Download GLB
                    </a>
                  </>
                ) : (
                  <div className="output-empty">
                    {isStarting || isWorking ? (
                      <>
                        <span className="spinner" />
                        <strong>{isStarting ? "Starting" : "Processing"}</strong>
                        <small>{run?.progress ?? 0}% complete</small>
                        <div className="progress-track">
                          <span style={{ width: `${isStarting ? 0 : run?.progress ?? 0}%` }} />
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="cube-placeholder"><CubeIcon /></span>
                        <strong>Upload image and select an installed model to generate</strong>
                        <small>Ready for generation</small>
                      </>
                    )}
                  </div>
                )}
              </div>
              <div
                className="resize-handle"
                aria-label="Resize output node"
                onPointerDown={(event) => beginNodePointer(event, "output", "resize")}
              />
            </div>
          </div>

          {activeError && <div className="error-banner">{activeError}</div>}
        </section>

        {isPropertiesOpen && <button type="button" className="properties-backdrop" aria-label="Close properties panel" onClick={() => setIsPropertiesOpen(false)} />}
        <aside className={`properties-panel w-80 flex-shrink-0 flex flex-col h-full overflow-y-auto fixed inset-y-0 right-0 md:relative ${isPropertiesOpen ? "open" : ""}`}>
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Selected node</span>
              <h2>{selectedNodeId === "source-image" ? "Source Image" : "3D Output"}</h2>
            </div>
            <button type="button" className="close-properties" onClick={() => setIsPropertiesOpen(false)} aria-label="Close properties panel">×</button>
          </div>
          {selectedExtension ? (
            <div className="properties-content">
              <div className="property-hero">
                <span><CubeIcon /></span>
                <strong>{selectedExtension.name}</strong>
              </div>
              {selectedNodeId === "source-image" ? (
                <dl className="selected-node-metadata">
                  <div><dt>Node</dt><dd>Source Image</dd></div>
                  <div><dt>Image</dt><dd>{uploadedImage?.name ?? "No image selected"}</dd></div>
                  <div><dt>Format</dt><dd>{uploadedImage?.type || "—"}</dd></div>
                  <div><dt>Size</dt><dd>{uploadedImage ? `${(uploadedImage.size / 1024 / 1024).toFixed(2)} MB` : "—"}</dd></div>
                </dl>
              ) : (
                <dl className="selected-node-metadata">
                  <div><dt>Node</dt><dd>3D Output</dd></div>
                  <div><dt>Status</dt><dd>{runLabel}</dd></div>
                  <div><dt>Progress</dt><dd>{run?.progress ?? 0}%</dd></div>
                  <div><dt>Format</dt><dd>GLB</dd></div>
                </dl>
              )}
              <dl>
                <div><dt>Model ID</dt><dd>{selectedExtension.id}</dd></div>
                <div><dt>Version</dt><dd>{selectedExtension.version}</dd></div>
                <div><dt>Type</dt><dd>{selectedExtension.type}</dd></div>
                <div><dt>Hardware</dt><dd>{selectedExtension.requires_gpu ? "GPU required" : "Standard"}</dd></div>
                <div><dt>Readiness</dt><dd>{selectedExtension.status_message}</dd></div>
              </dl>
              {!selectedExtension.is_ready && (
                <div className="extension-readiness-warning" role="alert">
                  Generation is unavailable: {selectedExtension.status_message}
                </div>
              )}
              <ExtensionDocPanel
                docs={extensionDocs}
                loading={extensionDocsLoading}
                error={extensionDocsError}
                onLoadRecommended={(recommended) => {
                  setParameterValues((current) => ({ ...current, ...recommended }));
                }}
              />
              <div className="extension-parameters">
                <h3>Settings</h3>
                {Object.entries(selectedExtension.parameters ?? {}).length === 0 ? (
                  <p className="no-parameters">This model requires no additional settings.</p>
                ) : Object.entries(selectedExtension.parameters ?? {}).map(([name, parameter]) => {
                  const label = parameter.label ?? name;
                  const value = parameterValues[name] ?? getParameterDefault(parameter);
                  const controlId = `parameter-${name}`;

                  if (parameter.type === "boolean") {
                    return (
                      <label className="parameter-toggle" key={name} htmlFor={controlId}>
                        <span>{label}</span>
                        <input
                          id={controlId}
                          type="checkbox"
                          checked={Boolean(value)}
                          onChange={(event) => updateParameter(name, event.target.checked)}
                        />
                      </label>
                    );
                  }

                  if (parameter.type === "select") {
                    const options = parameter.options ?? [];
                    return (
                      <label className="parameter-control" key={name} htmlFor={controlId}>
                        <span>{label}</span>
                        <select
                          id={controlId}
                          value={String(value)}
                          onChange={(event) => {
                            const selected = options.find((option) => {
                              const optionValue = typeof option === "object" ? option.value : option;
                              return String(optionValue) === event.target.value;
                            });
                            updateParameter(name, selected === undefined
                              ? event.target.value
                              : typeof selected === "object" ? selected.value : selected);
                          }}
                        >
                          {options.map((option) => {
                            const optionValue = typeof option === "object" ? option.value : option;
                            const optionLabel = typeof option === "object" ? option.label ?? String(option.value) : String(option);
                            return <option key={String(optionValue)} value={String(optionValue)}>{optionLabel}</option>;
                          })}
                        </select>
                      </label>
                    );
                  }

                  if (parameter.type === "number" && parameter.min !== undefined && parameter.max !== undefined) {
                    return (
                      <label className="parameter-control" key={name} htmlFor={controlId}>
                        <span className="parameter-label-row"><span>{label}</span><output>{value}</output></span>
                        <input
                          id={controlId}
                          type="range"
                          min={parameter.min}
                          max={parameter.max}
                          step={parameter.step ?? 1}
                          value={Number(value)}
                          onChange={(event) => updateParameter(name, Number(event.target.value))}
                        />
                      </label>
                    );
                  }

                  return (
                    <label className="parameter-control" key={name} htmlFor={controlId}>
                      <span>{label}</span>
                      <input
                        id={controlId}
                        type={parameter.type === "number" ? "number" : "text"}
                        min={parameter.type === "number" ? parameter.min : undefined}
                        max={parameter.type === "number" ? parameter.max : undefined}
                        step={parameter.type === "number" ? parameter.step : undefined}
                        value={String(value)}
                        onChange={(event) => updateParameter(
                          name,
                          parameter.type === "number" ? Number(event.target.value) : event.target.value,
                        )}
                      />
                    </label>
                  );
                })}
              </div>
              <div className="property-actions">
                {isWorking ? (
                  <button type="button" className="cancel-button" onClick={() => void stop()}>
                    Cancel generation
                  </button>
                ) : (
                  <button
                    type="button"
                    className="generate-button"
                    disabled={!selectedExtension || !selectedExtension.is_ready || !uploadedImage || isGenerating}
                    onClick={generateAndInspect}
                  >
                    {isStarting ? "Starting…" : "Generate 3D & Inspect"}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="empty-properties">Select an installed model to configure it.</div>
          )}
        </aside>
      </div>
      )}
      {dependencyPrompt && (
        <DependencyPromptModal
          extension={dependencyPrompt.extension}
          audit={dependencyPrompt.audit}
          installing={installingDependencies}
          error={dependencyInstallError}
          onInstall={() => void installPromptDependencies()}
          onSkip={() => {
            setDependencyPrompt(null);
            setDependencyInstallError("");
          }}
        />
      )}
    </main>
  );
}
