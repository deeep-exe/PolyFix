import { useState } from "react";
import { useRun } from "./hooks/useRun";
import Viewer from "./components/Viewer";
import { resultUrl } from "./api/client";

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const { run, start } = useRun();

  return (
    <div className="max-w-xl mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-bold">Image to 3D</h1>

      <input
        type="file"
        accept="image/*"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />

      <button
        className="px-4 py-2 rounded bg-blue-600 text-white disabled:opacity-50"
        disabled={!file}
        onClick={() => file && start(file)}
      >
        Generate 3D model
      </button>

      {run && (
        <div>
          <p>Status: {run.status}</p>

          <div className="w-full h-3 bg-gray-200 rounded">
            <div
              className="h-3 bg-blue-600 rounded"
              style={{ width: `${run.progress}%` }}
            />
          </div>

          {run.error && <p className="text-red-600">{run.error}</p>}

          {run.status === "done" && (
            <>
              <Viewer url={resultUrl(run.id)} />
              <a
                className="underline text-blue-600"
                href={resultUrl(run.id)}
                download={`model-${run.id}.glb`}
              >
                Download .glb
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}