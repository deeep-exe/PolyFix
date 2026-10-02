import { Canvas } from "@react-three/fiber";
import { OrbitControls, Stage, useGLTF } from "@react-three/drei";
import { Suspense } from "react";

function Model({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  return <primitive object={scene} />;
}

export default function Viewer({ url }: { url: string }) {
  return (
    <div className="w-full h-96 border rounded">
      <Canvas camera={{ position: [0, 0, 3] }}>
        <Suspense fallback={null}>
          <Stage>
            <Model url={url} />
          </Stage>
        </Suspense>
        <OrbitControls makeDefault />
      </Canvas>
    </div>
  );
}