import { useEffect, useState } from "react";
import { useRun } from "./hooks/useRun";
import Viewer from "./components/Viewer";
import { resultUrl, getExtensions } from "./api/client";


import InstallExtension from "./components/InstallExtension";

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [extensions, setExtensions] = useState<any[]>([]);
  const [selectedExt, setSelectedExt] = useState<string>("");
  const { run, start } = useRun();

  // Load the list of extensions once when the page opens
  useEffect(() => {
    getExtensions()
      .then((list) => {
        setExtensions(list);
        if (list.length > 0) setSelectedExt(list[0].id); // default to first one
      })
      .catch(console.error);
  }, []);

  return (
    <div className="max-w-xl mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-bold">Image to 3D</h1>
      <InstallExtension onInstalled={() => setTimeout(() => window.location.reload(), 1200)} /> 
      {/* Extension dropdown */}
      <select
        className="border rounded px-3 py-2 w-full"
        value={selectedExt}
        onChange={(e) => setSelectedExt(e.target.value)}
      >
        {extensions.map((ext) => (
          <option key={ext.id} value={ext.id}>
            {ext.name} (v{ext.version})
          </option>
        ))}
      </select>

      <input
        type="file"
        accept="image/*"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />

      <button
        className="px-4 py-2 rounded bg-blue-600 text-white disabled:opacity-50"
        disabled={!file || !selectedExt}
        onClick={() => file && start(file, selectedExt)}
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