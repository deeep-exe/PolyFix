import { useRef, useState } from "react";
import { installExtensionZip } from "../api/client";

type Props = {
  onInstalled: () => void;
  onStartInstall: (url: string) => Promise<string>;
};

export default function InstallExtension({ onInstalled, onStartInstall }: Props) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const zipInput = useRef<HTMLInputElement>(null);

  async function install() {
    const value = url.trim();
    if (!value) return;
    setBusy(true);
    setMessage(null);
    try {
      await onStartInstall(value);
      setMessage({ ok: true, text: "Download started. Track progress below." });
      setUrl("");
      onInstalled();
    } catch (e) {
      setMessage({
        ok: false,
        text: e instanceof Error ? e.message : "Could not start the installation.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function uploadZip(file?: File) {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      await installExtensionZip(file);
      setMessage({ ok: true, text: "ZIP upload started. Track progress below." });
      onInstalled();
    } catch (e) {
      setMessage({
        ok: false,
        text: e instanceof Error ? e.message : "Could not upload the ZIP archive.",
      });
    } finally {
      setBusy(false);
      if (zipInput.current) zipInput.current.value = "";
    }
  }

  return (
    <div className="install-extension">
      <label>Install Model</label>
      <div className="source-pills">
        <button type="button" onClick={() => setUrl("https://github.com/")}>GitHub</button>
        <button type="button" onClick={() => setUrl("https://huggingface.co/")}>Hugging Face</button>
        <button type="button" onClick={() => zipInput.current?.click()}>Local ZIP</button>
      </div>
      <input
        ref={zipInput}
        className="zip-file-input"
        type="file"
        accept=".zip,application/zip"
        onChange={(event) => void uploadZip(event.target.files?.[0])}
      />
      <div className="install-row">
        <input
          placeholder="Paste GitHub repo, Hugging Face URL, or Model ID (e.g., tencent/Hunyuan3D-2mini)"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={busy}
          onKeyDown={(event) => {
            if (event.key === "Enter" && url.trim()) void install();
          }}
        />
        <button onClick={() => void install()} disabled={busy || url.trim() === ""}>
          {busy ? "…" : "Install"}
        </button>
      </div>
      {message && (
        <p className={message.ok ? "install-success" : "install-error"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
