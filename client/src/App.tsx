import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Me } from "./api";
import { Landing } from "./pages/Landing";
import { Dashboard } from "./pages/Dashboard";
import { Settings } from "./pages/Settings";

type Tab = "dashboard" | "settings";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>(
    window.location.pathname.startsWith("/settings") ? "settings" : "dashboard"
  );

  const refresh = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setMe(null);
      else throw error;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function go(next: Tab) {
    setTab(next);
    window.history.pushState({}, "", next === "settings" ? "/settings" : "/dashboard");
  }

  if (loading) return <div className="center" style={{ color: "var(--muted)" }}>Loading…</div>;
  if (!me) return <Landing />;

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">textbook</div>
        <nav className="nav">
          <a
            href="/dashboard"
            className={tab === "dashboard" ? "active" : ""}
            onClick={(e) => {
              e.preventDefault();
              go("dashboard");
            }}
          >
            Dashboard
          </a>
          <a
            href="/settings"
            className={tab === "settings" ? "active" : ""}
            onClick={(e) => {
              e.preventDefault();
              go("settings");
            }}
          >
            Settings
          </a>
          <button
            className="secondary"
            onClick={async () => {
              await api.logout();
              window.location.href = "/";
            }}
          >
            Sign out
          </button>
        </nav>
      </div>

      {tab === "dashboard" ? (
        <Dashboard me={me} onRefresh={refresh} />
      ) : (
        <Settings me={me} onRefresh={refresh} />
      )}
    </div>
  );
}
