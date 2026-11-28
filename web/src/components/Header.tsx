import type { BackendConnectionState } from "../api/client";
import { useTheme } from "../theme/ThemeContext";

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
  const { theme, toggleTheme } = useTheme();
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
            {/* BASE_URL is "./", so this resolves next to index.html both in the
                dev server and when Electron loads the build from file:// */}
            <img src={`${import.meta.env.BASE_URL}box.png`} alt="" />
          </div>
          <div>
            <strong>PolyFix</strong>
            <span>Model Studio</span>
          </div>
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
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
        >
          {theme === "light" ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20.2 15.4A8.5 8.5 0 0 1 8.6 3.8 8.5 8.5 0 1 0 20.2 15.4Z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
            </svg>
          )}
        </button>
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
