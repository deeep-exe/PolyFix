import type { ExtensionDependencyAudit, ExtensionManifest } from "../api/client";

type Props = {
  extension: ExtensionManifest;
  audit: ExtensionDependencyAudit;
  installing: boolean;
  error: string;
  onInstall: () => void;
  onSkip: () => void;
};

export default function DependencyPromptModal({
  extension,
  audit,
  installing,
  error,
  onInstall,
  onSkip,
}: Props) {
  return (
    <div className="dependency-modal-backdrop" role="presentation">
      <section
        className="dependency-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dependency-modal-title"
      >
        <div className="dependency-modal-icon" aria-hidden="true">⚠</div>
        <div>
          <span className="eyebrow">Model Readiness</span>
          <h2 id="dependency-modal-title">Missing Dependencies Detected</h2>
          <p><strong>{extension.name}</strong> is not ready to run.</p>
        </div>

        {audit.missing_packages.length > 0 && (
          <div className="dependency-list">
            <span>Missing packages</span>
            <ul>
              {audit.missing_packages.map((packageName) => (
                <li key={packageName}>{packageName}</li>
              ))}
            </ul>
          </div>
        )}

        {!audit.cuda_available && extension.requires_gpu && (
          <div className="dependency-cuda-warning">
            CUDA is unavailable on this host. GPU acceleration will remain disabled.
          </div>
        )}

        {error && <div className="dependency-modal-error" role="alert">{error}</div>}

        <div className="dependency-modal-actions">
          <button type="button" className="dependency-skip" onClick={onSkip} disabled={installing}>
            Skip for Now
          </button>
          <button type="button" className="dependency-install" onClick={onInstall} disabled={installing}>
            {installing && <span className="dependency-spinner" aria-hidden="true" />}
            {installing ? "Installing Dependencies…" : "Auto-Install Dependencies Now"}
          </button>
        </div>
      </section>
    </div>
  );
}
