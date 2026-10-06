import { useState } from "react";
 
const API = "http://localhost:8000";
 
type Props = { onInstalled: () => void };
 
export default function InstallExtension({ onInstalled }: Props) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
 
  async function install() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${API}/extensions/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ ok: false, text: data.detail ?? "Install failed." });
      } else {
        setMessage({ ok: true, text: `Installed "${data.name}"!` });
        setUrl("");
        onInstalled();
      }
    } catch {
      setMessage({ ok: false, text: "Cannot reach the backend. Is uvicorn running?" });
    } finally {
      setBusy(false);
    }
  }
 
  return (
    <div className="w-full max-w-2xl mx-auto my-6">
      <label className="block mb-2 text-sm text-gray-300">
        Install an extension from GitHub
      </label>
      <div className="flex gap-2">
        <input
          className="flex-1 px-3 py-2 rounded border border-gray-600 bg-transparent"
          placeholder="https://github.com/user/repo"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
        />
        <button
          className="px-4 py-2 rounded bg-blue-600 text-white disabled:opacity-50"
          onClick={install}
          disabled={busy || url.trim() === ""}
        >
          {busy ? "Installing..." : "Install"}
        </button>
      </div>
      {message && (
        <p className={`mt-2 text-sm ${message.ok ? "text-green-400" : "text-red-400"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
