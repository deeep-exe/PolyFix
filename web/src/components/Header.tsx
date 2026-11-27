import type { BackendConnectionState } from "../api/client";

type HeaderProps = {
  activeView: "studio" | "qa";
  setActiveView: (view: "studio" | "qa") => void;
  backendStatus: BackendConnectionState;
  checkingBackend: boolean;
  processing: boolean;
  onRetryConnection: () => void;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenProperties?: () => void;
};

export default function Header({
  activeView,
  setActiveView,
  backendStatus,
  checkingBackend,
  processing,
  onRetryConnection,
  isSidebarOpen,
  onToggleSidebar,
  onOpenProperties,
}: HeaderProps) {
  const connected = backendStatus === "connected";
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          type="button"
          className={`hamburger-button ${isSidebarOpen ? "active" : ""}`}
          onClick={onToggleSidebar}
          aria-label={isSidebarOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={isSidebarOpen}
          title={isSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <line x1="4" y1="7" x2="20" y2="7" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="17" x2="20" y2="17" />
          </svg>
        </button>

        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="m12 2 8.5 4.9v9.8L12 22l-8.5-5.3V6.9L12 2Z" /><path d="m3.8 7 8.2 4.9L20.2 7M12 12v9.7" /></svg>
          </div>
          <div>
            <strong>PolyFix</strong>
            <span>Model Studio</span>
          </div>
          <span className="version-badge">v1.0</span>
        </div>
      </div>

      <nav className="view-nav phase-nav" aria-label="Phase navigation">
        <button
          type="button"
          className={activeView === "studio" ? "active" : ""}
          onClick={() => setActiveView("studio")}
        >
          Node Studio <small>Phase 1</small>
        </button>
        <button
          type="button"
          className={activeView === "qa" ? "active" : ""}
          onClick={() => setActiveView("qa")}
        >
          3D QA Dashboard <small>Phase 2</small>
          {processing && <i className="qa-processing-dot" aria-label="Generation processing" />}
        </button>
      </nav>

      <div className="topbar-actions">
        {activeView === "studio" && onOpenProperties && (
          <button
            type="button"
            className="properties-trigger"
            onClick={onOpenProperties}
          >
            Inspector
          </button>
        )}
        {backendStatus === "checking" ? (
          <span className="status-dot status-checking"><i /> Checking</span>
        ) : (
          <button
            type="button"
            className={`header-backend ${connected ? "connected" : "offline"}`}
            disabled={connected || checkingBackend}
            onClick={() => {
              if (!connected) onRetryConnection();
            }}
          >
            <i />
            {checkingBackend ? "Checking..." : connected ? "Connected" : "Offline"}
          </button>
        )}
      </div>
    </header>
  );
}
