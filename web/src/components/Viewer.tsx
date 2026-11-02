import { Canvas } from "@react-three/fiber";
import { OrbitControls, Stage, useGLTF } from "@react-three/drei";
import { Suspense, useEffect } from "react";
import * as THREE from "three";

function Model({
  url,
  wireframe,
  heatmap,
}: {
  url: string;
  wireframe: boolean;
  heatmap: boolean;
}) {
  const { scene } = useGLTF(url);
  useEffect(() => {
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.material = Array.isArray(object.material)
        ? object.material.map((material) => {
            const copy = material.clone();
            copy.wireframe = wireframe;
            if (heatmap) copy.color.set("#d977c8");
            return copy;
          })
        : (() => {
            const copy = object.material.clone();
            copy.wireframe = wireframe;
            if (heatmap) copy.color.set("#d977c8");
            return copy;
          })();
    });
  }, [scene, wireframe, heatmap]);
  return <primitive object={scene} />;
}

export default function Viewer({
  url,
  wireframe = false,
  heatmap = false,
  autoRotate = true,
}: {
  url: string;
  wireframe?: boolean;
  heatmap?: boolean;
  autoRotate?: boolean;
}) {
  return (
    <div className="viewer-canvas">
      <Canvas camera={{ position: [0, 0, 3] }} dpr={[1, 2]}>
        <Suspense fallback={null}>
          <Stage environment="city" intensity={0.55}>
            <Model url={url} wireframe={wireframe} heatmap={heatmap} />
          </Stage>
        </Suspense>
        <OrbitControls makeDefault autoRotate={autoRotate} autoRotateSpeed={0.7} />
      </Canvas>
    </div>
  );
}