import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { api, type AppConfig } from "./api";
import { CandidatesPage } from "./pages/Candidates";
import { JudgePage } from "./pages/Judge";
import { ApiKeysPage } from "./pages/ApiKeys";
import { DashboardPage } from "./pages/Dashboard";
import { GenerationsPage } from "./pages/Generations";
import { PersonasPage } from "./pages/Personas";
import { ErrorsPage } from "./pages/Errors";

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setConfig(await api.getConfig());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="min-h-screen">
      <header className="glass mx-auto mt-6 flex max-w-5xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <img src="/OpenFusion-logo.png" alt="OpenFusion" className="h-10 w-10 rounded-lg" />
          <div>
            <h1 className="text-lg font-semibold leading-tight">
              <span className="bg-gradient-to-r from-[#4cd0b0] to-[#3498db] bg-clip-text text-transparent">
                OpenFusion
              </span>
            </h1>
            <p className="text-xs text-white/60">Fusion panel MCP server</p>
          </div>
        </div>
        <nav className="flex gap-1 text-sm">
          {[
            ["/dashboard", "Dashboard"],
            ["/generations", "Generations"],
            ["/candidates", "Candidates"],
            ["/judge", "Judge"],
            ["/personas", "Personas"],
            ["/keys", "API Keys"],
            ["/errors", "Errors"],
          ].map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 transition ${
                  isActive ? "bg-[#4cd0b0]/20 text-[#4cd0b0]" : "text-white/70 hover:bg-white/10"
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        {config && (
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              config.configured ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"
            }`}
          >
            {config.configured ? "● Configured" : "○ Needs setup"}
          </span>
        )}
      </header>

      {error && (
        <div className="mx-auto mt-4 max-w-5xl rounded-md bg-red-500/20 px-4 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      {!config?.configured && (
        <div className="mx-auto mt-4 max-w-5xl rounded-md bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          OpenFusion isn't configured yet. Add ≥2 candidates, a judge, and an API key for each referenced provider to enable the{" "}
          <code className="rounded bg-black/30 px-1">fusion</code> tool.{" "}
          <Link to="/candidates" className="underline">
            Start with candidates →
          </Link>
        </div>
      )}

      <main className="mx-auto max-w-5xl px-4 py-6">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/generations" element={<GenerationsPage />} />
          <Route path="/errors" element={<ErrorsPage />} />
          <Route path="/candidates" element={<CandidatesPage config={config} onChanged={refresh} />} />
          <Route path="/judge" element={<JudgePage config={config} onChanged={refresh} />} />
          <Route path="/personas" element={<PersonasPage />} />
          <Route path="/keys" element={<ApiKeysPage config={config} />} />
        </Routes>
      </main>
    </div>
  );
}
