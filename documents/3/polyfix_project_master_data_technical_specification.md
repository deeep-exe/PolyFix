# PolyFix: Master Project Specification & Technical Data Repository

---

## 1. Executive Summary & Institutional Metadata

* **Project Title:** PolyFix (Adaptive CLI Orchestration & Verifier-Guided Quality Assurance for Generative 3D Game Assets)
* **Short Identifier:** PolyFix / AutoMesh-Pipeline
* **Project Status:** Approved
* **Approved Student Role:** Lead Systems Architect & Core Developer
* **Student Name:** Manish Kumar
* **Student SRN:** PES1PG25CA122
* **Department:** Master of Computer Applications (MCA)
* **Institution:** PES University
* **Faculty Guide:** Mr. Abubakar Siddik (Faculty Associate, Dept. of Computer Applications)
* **Domain:** Computer Graphics, 3D Computational Geometry, Microservice Orchestration, Verifier-Guided Quality Assurance

---

## 2. Problem Statement & Problem-Solution Matrix

### 2.1 The Assetization Bottleneck & Deployability Gap
* **Raw AI Output Deficiencies:** Generative 3D AI models (e.g., TRELLIS, Tripo3D, Replicate, Shap-E) prioritize 2D/3D visual plausibility over structural validity. They output high-poly "triangle soup" containing non-manifold edges, open boundary loops, flipped surface normals, and overlapping UV maps.
* **Manual Technical Artist Overhead:** Converting a raw generative mesh into an engine-ready asset in Blender/Maya takes **30 to 60 minutes** per model (retopology, UV unwrapping, material decoupling, baking).
* **Failure of Static Open-Loop Scripts:** Commercial presets apply rigid decimation percentages (e.g., cut polygons blindly by 80%). This destroys fine geometric features on complex shapes while under-optimizing simple, flat surfaces.

### 2.2 PolyFix Solution Summary
PolyFix is an **open, model-agnostic, deterministic post-processing orchestration pipeline** written in Python. It evaluates surface curvature variance ($\sigma^2$), computes dynamic retopology parameters in $<2\text{ ms}$, drives background command-line tools (Instant Meshes CLI and headless Blender `bpy`), and enforces engine readiness via a **5-Axis Game-Asset Readiness (GAR)** closed-loop repair state machine capped at **2 retries**.

---

## 3. Scope Boundaries & Project Metrics

### 3.1 Project Scope Breakdown
* **In-Scope:**
  * Ingestion of raw high-poly `.obj` and `.glb` generative meshes.
  * `trimesh` geometry inspection & adjacency angle normal analysis.
  * Curvature-aware parameter math ($\sigma^2$).
  * Automated quad retopology via Instant Meshes CLI.
  * Headless Blender (`bpy`) Smart UV projection & ray-cast PBR (Normal + AO) texture baking.
  * Point-cloud bidirectional Hausdorff distance evaluation via `scipy.spatial.cKDTree`.
  * Bounded closed-loop self-repair state machine (hard-capped at 2 retries).
  * Standalone schema and topology validation via Khronos `glTF-Validator` CLI.
* **Out-of-Scope:**
  * Training generative 3D neural network base models.
  * Interactive manual mesh sculpting tools.
  * Proprietary studio lock-in platforms.
  * Real-time skeletal rigging and skinning weights generation.

### 3.2 High-Level Metric Targets
* **Batch Test Size:** 20 Raw AI Assets processed end-to-end.
* **glTF-Validator Pass Rate:** 100% (0 schema errors, 0 invalid buffer offsets).
* **Maximum Hausdorff Shape Distortion ($\epsilon$):** $< 0.02$ spatial error tolerance.
* **Maximum Auto-Repair Retries:** Hard cap of 2 iterations.
* **Parameter Calculation Time:** $< 2\text{ ms}$ on standard CPU.

---

## 4. Technology Stack & Subprocess Tool Chain

| Component / Subsystem | Technology | Engineering Rationale & Specific Function |
| :--- | :--- | :--- |
| **Pipeline Core** | **Python 3.10+** | State machine management, subprocess orchestration, and REST API routing via FastAPI. |
| **Mesh Math & Inspection** | **trimesh & NumPy** | Graph connectivity inspection, half-edge checks, face-normal adjacency math, and curvature variance ($\sigma^2$). |
| **Spatial Error Metric** | **scipy.spatial (cKDTree)** | Fast $k$-d tree nearest-neighbor sampling for bidirectional Hausdorff distance calculation. |
| **Quad Retopology Engine** | **Instant Meshes CLI** | Pre-compiled C++ executable for fast, field-aligned quad remeshing driven via Python `subprocess.run()`. |
| **UV & Texture Baking** | **Headless Blender (`bpy`)** | Background script execution (`blender -b -P bake.py`) for automated 2D Smart UV projection and high-to-low Normal/AO baking. |
| **Schema Validation** | **Khronos glTF-Validator CLI** | Standalone CLI binary for programmatically checking glTF 2.0 schema and buffer compliance without game engine bloat. |

---

## 5. Mathematical Models & Heuristic Formulations

### 5.1 Adjacency Normal Angle Calculation
For adjacent polygons $F_1$ and $F_2$ with surface normal vectors $\mathbf{n}_1$ and $\mathbf{n}_2$:
$$\theta = \arccos\left(\frac{\mathbf{n}_1 \cdot \mathbf{n}_2}{\|\mathbf{n}_1\| \|\mathbf{n}_2\|}\right)$$

### 5.2 Curvature Variance ($\sigma^2$)
Measures local surface topological complexity across $N$ face adjacency pairs:
$$\sigma^2 = \frac{1}{N}\sum_{i=1}^{N} (\theta_i - \bar{\theta})^2$$

### 5.3 Dynamic Quad Poly Budget ($Q_{\text{target}}$)
Replaces rigid percentage reductions by scaling quad allocation proportionally to surface complexity and total area:
$$Q_{\text{target}} = Q_{\text{base}} \cdot (1.0 + \sigma^2)$$
*Alternative non-linear formulation:*
$$P_{\text{budget}} = k \cdot \text{SurfaceArea} \cdot (1 + e^{\lambda \sigma^2})$$

### 5.4 Bidirectional Hausdorff Distance Metric
Evaluates spatial geometric error between dense point cloud samples of the original raw high-poly mesh ($A$) and low-poly quad output ($B$):
$$H(A, B) = \max\left( \sup_{a \in A} \inf_{b \in B} d(a,b), \sup_{b \in B} \inf_{a \in A} d(a,b) \right)$$
*Calculated using `scipy.spatial.cKDTree` nearest-neighbor lookup.*

---

## 6. 5-Axis Game-Asset Readiness (GAR) Framework

The 5-Axis GAR metric defines the programmatic evaluation threshold for engine deployment:

1. **Axis 1: Mesh Health & Topology:**
   * **Rule:** 0 non-manifold edges, 0 flipped surface normals, 0 unclosed boundary holes.
   * **Tool:** `trimesh.repair`.
2. **Axis 2: Asset Weight & Poly Budget:**
   * **Rule:** Total polygon count $\le Q_{\text{target}}$ (e.g., $< 5,000$ quads for props).
   * **Tool:** Instant Meshes CLI.
3. **Axis 3: Texture Atlas & UV Quality:**
   * **Rule:** 0% UV island overlap, minimum 0.02 island margin padding.
   * **Tool:** Headless Blender (`bpy`).
4. **Axis 4: Surface Detail & PBR Completeness:**
   * **Rule:** High-to-low Normal and Ambient Occlusion (AO) maps baked and wired into glTF PBR material nodes.
   * **Tool:** Headless Blender (`bpy`).
5. **Axis 5: Shape Fidelity (Geometric Retention):**
   * **Rule:** Bidirectional Hausdorff distance $H(A, B) < \epsilon$ (where default threshold $\epsilon = 0.02$).
   * **Tool:** `scipy.spatial.cKDTree`.

---

## 7. 6-Stage Pipeline & Closed-Loop Repair State Machine

### 7.1 Pipeline Stages
```
[Stage 1: Ingestion & Audit] ──► [Stage 2: Dynamic Heuristics] ──► [Stage 3: CLI Execution]
                                                                            │
[Stage 6: Export & Validation] ◄── [Stage 5: Auto-Repair Loop] ◄── [Stage 4: 5-Axis GAR QA]
```

1. **Stage 1: Geometry Inspection:** Ingests raw mesh, audits face normals, checks manifold connectivity using `trimesh`.
2. **Stage 2: Adaptive Parameter Tuning:** Calculates curvature variance ($\sigma^2$) and derives $Q_{\text{target}}$ and UV margins.
3. **Stage 3: Subprocess Tool Execution:** Invokes Instant Meshes CLI for quad remeshing and headless Blender (`bpy`) for Smart UV unwrapping and ray-cast PBR baking.
4. **Stage 4: 5-Axis GAR Verification:** Computes Hausdorff distance $H(A,B)$ and checks all 5 GAR criteria.
5. **Stage 5: Bounded Auto-Repair State Machine:** If any axis fails and `retry_count < 2`:
   * **If Shape Loss Failed ($H(A,B) > \epsilon$):** Scale $Q_{\text{target}} \leftarrow Q_{\text{target}} \cdot 1.5$ and reduce smoothing passes.
   * **If UV Overlap Failed:** Reduce Blender angle projection threshold ($66^\circ \rightarrow 45^\circ$) and increase island padding margin to $0.02$.
   * **Re-run Stage 3 and Stage 4.**
6. **Stage 6: Engine Validation & Export:** Runs Khronos `glTF-Validator` CLI and exports spec-compliant `.glb`/`.gltf` asset.

### 7.2 The 5-Axis Automated Repair Matrix

| Failure Axis Detected | Root Cause | Automated Repair Action Taken |
| :--- | :--- | :--- |
| **1. Topological Defects** | Disconnected vertices, flipped face winding directions | `trimesh.repair.merge_vertices(1e-5)`, `fix_normals()`, `fill_holes()`. |
| **2. High Shape Distortion** ($H(A,B) > \epsilon$) | Aggressive decimation destroyed fine geometric features | Scale quad budget by $1.5\times$ ($Q_{\text{target}} \leftarrow Q_{\text{target}} \cdot 1.5$) and reduce Instant Meshes smoothing passes. |
| **3. UV Overlaps** ($> 0\%$) | Complex UV shells overlapping on 2D atlas | Lower Blender projection angle ($66^\circ \rightarrow 45^\circ$) and increase padding margin ($\text{margin} = 0.02$). |
| **4. PBR Baking Artifacts** | Ray-casting ray misses surface peaks on high-poly mesh | Dynamically widen Blender `baking_ray_distance` search margin and recalculate cage bounds. |
| **5. Schema Validation Failure** | Invalid glTF buffer offsets or non-standard attributes | Run `gltf-transform` container sanitization to re-index buffers and repack binary `.glb`. |

---

## 8. Comparative Analysis Table

| Feature / Dimension | Manual Artist Cleanup | Static Decimation Presets | Tencent Hunyuan3D Studio | PolyFix (Ours) |
| :--- | :--- | :--- | :--- | :--- |
| **Execution Model** | Manual Human Labor | Open-Loop Script | Proprietary Neural Pipeline | Closed-Loop Verifier State Machine |
| **Parameter Tuning** | Intuition / Experience | Fixed Percentage (e.g., 80%) | Internal Neural Weights | Dynamic Curvature Math ($\sigma^2$) |
| **Quality Verification** | Visual Check (Subjective) | None | Closed Platform Check | 5-Axis GAR Metric + Khronos CLI |
| **Shape Loss Metric** | Visual Comparison | None | None | Point-Cloud Hausdorff Distance (`cKDTree`) |
| **UV & PBR Assetization** | Manual (30–60 mins) | None (Wireframe Only) | Integrated | Headless Blender (`bpy`) Automated Baking |
| **Compute / Hardware Cost** | High Labor Cost | Very Low | Heavy GPU Cluster | Lightweight CPU & Subprocess CLI |
| **Model Compatibility** | Universal | Universal | Vendor-Locked (Tencent) | Model-Agnostic (Any Raw Mesh) |

---

## 9. Key Evaluator Questions & Bulletproof Defenses

### Q1: "Isn't PolyFix just glue code wrapping Blender and Instant Meshes?"
* **Defense:** Commercial tools and scripts run open-loop using fixed static presets (e.g., "always cut polys by 80%"), which destroys detail on complex shapes. PolyFix introduces an **adaptive heuristic decision engine** that analyzes curvature variance ($\sigma^2$) in $<2\text{ ms}$, coupled with a **closed-loop verifier state machine** that automatically diagnoses and repairs topological and shape failures.

### Q2: "Commercial platforms like Hunyuan3D Studio already exist. Why build PolyFix?"
* **Defense:** Hunyuan3D Studio is a proprietary, vendor-locked "black box" tied to Tencent's neural generators. PolyFix is an **open, model-agnostic post-processor** designed to clean output from *any* 3D generator (TRELLIS, Tripo3D, open datasets). Furthermore, commercial tools operate open-loop, whereas PolyFix incorporates a closed-loop verifier state machine.

### Q3: "Why use heuristic math ($\sigma^2$) instead of training a deep learning evaluator?"
* **Defense:** Deep learning evaluators are black boxes prone to hallucinations, slow inference times, and heavy GPU requirements. Curvature variance ($\sigma^2$) inspects face normal adjacency angles deterministically on CPU in $<2\text{ ms}$, giving exact, transparent parameter settings without GPU bloat.

### Q4: "How do you mathematically prove that decimation didn't destroy fine geometric details?"
* **Defense:** PolyFix extracts dense surface point cloud samples from both the raw high-poly mesh and the low-poly quad mesh, calculating the bidirectional Hausdorff distance using `scipy.spatial.cKDTree`. This provides a precise mathematical error score ($H(A,B) < \epsilon$) rather than relying on subjective visual inspection.

### Q5: "What prevents your auto-repair loop from running indefinitely?"
* **Defense:** The repair state machine enforces a strict control-theory hard cap of **2 retries**. If an asset fails GAR metrics after two repair attempts, PolyFix safely terminates and outputs an explicit diagnostic log identifying the failing metric.

---

## 10. Key Literature Citations

1. **FA-QEM Paper (*arXiv:2605.14029*):** *"Fast and Robust Mesh Simplification for Generated and Real-World 3D Assets"* — Base literature for curvature-aware mesh simplification and point-sampled Hausdorff distance evaluation.
2. **MeshFIM Paper (*arXiv:2605.08744*):** *"Local Low-Poly Mesh Editing via Fill-in-the-Middle Autoregressive Generation"* — Justification for multi-pass iterative defect detection and capping repair cycles at 1–2 retries.
3. **3D Asset Generation Survey (*arXiv:2604.23629*):** *"From Visual Synthesis to Interactive Worlds: Toward Production-Ready 3D Asset Generation"* — Section 3 details engine-level constraints on topology, UV parameterization, and PBR materials.
4. **Hunyuan3D Studio Paper (*arXiv:2509.12815*):** *"Hunyuan3D Studio: End-to-End AI Pipeline for Game-Ready 3D Asset Generation"* — Industrial reference for multi-stage game-ready finishing pipelines.
