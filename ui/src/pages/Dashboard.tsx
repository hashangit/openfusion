import { useEffect, useRef, useState } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { api, type Stats, type Activity, type FusionRuntimeStatus, type ActiveFusion } from "../api";
import { ActivityTable } from "../components/ActivityTable";

export function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [items, setItems] = useState<Activity[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const [s, a] = await Promise.all([api.getStats(), api.getActivity({ limit: 25 })]);
      setStats(s);
      setItems(a.items);
      setTotal(a.total);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  // Re-fetch when the Dashboard tab becomes visible again, so charts reflect fusions
  // that landed while the user was away. Without this the charts are frozen at the
  // last page-load / manual-Refresh snapshot — the only other refresh trigger.
  // Stored in a ref so the listener (bound once) always invokes the latest refresh().
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const k = stats?.kpis;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Usage dashboard</h2>
        <button className="btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {/* Server Status (feature 007) — live fusion-engine state from GET /api/runtime */}
      <ServerStatus />

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="Fusions" value={k ? String(k.fusionCount) : "—"} />
        <Kpi label="Total cost" value={k ? `$${k.totalCost.toFixed(4)}` : "—"} />
        <Kpi label="Total tokens" value={k ? k.totalTokens.toLocaleString() : "—"} />
        <Kpi label="Avg latency" value={k ? `${(k.avgLatencyMs / 1000).toFixed(1)}s` : "—"} />
        <Kpi
          label="Success rate"
          value={k ? `${(k.successRate * 100).toFixed(0)}%` : "—"}
        />
      </div>

      {/* Charts */}
      <div className="grid gap-3 md:grid-cols-3">
        <section className="glass p-4">
          <h3 className="mb-2 text-sm font-medium text-white/70">Fusions per day</h3>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={stats?.fusionsByDay ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                <XAxis dataKey="day" stroke="rgba(255,255,255,0.5)" fontSize={11} />
                <YAxis stroke="rgba(255,255,255,0.5)" fontSize={11} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: "rgba(20,20,30,0.95)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 8,
                  }}
                />
                <Line type="monotone" dataKey="count" stroke="#3498db" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="glass p-4">
          <h3 className="mb-2 text-sm font-medium text-white/70">Cost by model</h3>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats?.costByModel ?? []} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                <XAxis type="number" stroke="rgba(255,255,255,0.5)" fontSize={11} />
                <YAxis
                  type="category"
                  dataKey="model"
                  stroke="rgba(255,255,255,0.5)"
                  fontSize={11}
                  width={120}
                />
                <Tooltip
                  contentStyle={{
                    background: "rgba(20,20,30,0.95)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 8,
                  }}
                />
                <Bar dataKey="cost" fill="#4cd0b0" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="glass p-4">
          <h3 className="mb-2 text-sm font-medium text-white/70">Token usage by model</h3>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats?.tokensByModel ?? []} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                <XAxis
                  type="number"
                  stroke="rgba(255,255,255,0.5)"
                  fontSize={11}
                  tickFormatter={(v: number) => compactNumber(v)}
                />
                <YAxis
                  type="category"
                  dataKey="model"
                  stroke="rgba(255,255,255,0.5)"
                  fontSize={11}
                  width={120}
                />
                <Tooltip
                  contentStyle={{
                    background: "rgba(20,20,30,0.95)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 8,
                  }}
                  formatter={(v) => [Number(v).toLocaleString(), "tokens"]}
                />
                <Bar dataKey="tokens" fill="#3498db" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      {/* Activity log */}
      <section className="glass p-4">
        <h3 className="mb-3 text-sm font-medium text-white/70">
          Activity ({total} total)
        </h3>
        {loading ? (
          <p className="text-sm text-white/50">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-white/50">
            No fusions yet. Once configured, calls to the <code>fusion</code> tool will appear here.
          </p>
        ) : (
          <ActivityTable items={items} />
        )}
      </section>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass-soft p-3">
      <p className="text-xs text-white/50">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
    </div>
  );
}

/** Compact a number for axis ticks (1500 -> "1.5k", 1200000 -> "1.2M"). */
function compactNumber(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

/**
 * Live fusion-engine status widget (feature 007). Polls GET /api/runtime (distinct from
 * /api/status) at a coarse 2s interval — paused when the tab is hidden, with an immediate
 * refetch on regain-focus so the affordance never shows stale progress (FR-015, R-006).
 * The affordance adapts to mode: parallel "X of N responding", serial "candidate X of N".
 */
function ServerStatus() {
  const [status, setStatus] = useState<FusionRuntimeStatus | null>(null);

  useEffect(() => {
    // Poll GET /api/runtime. setStatus is stable, so the poll fn needs no ref indirection.
    const poll = () =>
      api.getStatus().then(setStatus).catch(() => {
        // Best-effort: a failed poll (e.g. server briefly down) leaves the last snapshot.
      });
    void poll();
    const POLL_MS = 2000;
    const id = window.setInterval(() => {
      // Pause when hidden — pointless requests to a local server when nobody's looking.
      if (document.visibilityState === "visible") void poll();
    }, POLL_MS);
    const onVisible = () => {
      // Immediate refetch on focus so the widget never shows a frozen "candidate 3 of 5".
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const dot =
    status?.state === "idle"
      ? "bg-white/30"
      : status?.state === "queued"
        ? "bg-amber-400"
        : "bg-emerald-400";
  return (
    <section className="glass p-4">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
        <h3 className="text-sm font-medium text-white/80">Server status</h3>
      </div>
      <div className="mt-2">
        {status?.state === "idle" || !status ? (
          <p className="text-sm text-white/50">Idle — no fusion running.</p>
        ) : (
          <ul className="space-y-1">
            {status.fusions.map((f) => (
              <li key={f.activityId} className="text-sm text-white/70">
                {fusionLine(f)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** One fusion's affordance line — mode-aware (FR-013). */
function fusionLine(f: ActiveFusion): string {
  const elapsed = Math.max(0, Math.round((Date.now() - f.startedAt) / 1000));
  if (f.mode === "sequential") {
    const idx = f.candidateIndex ?? 1;
    const done = f.candidatesDone ?? 0;
    return `Running — candidate ${idx} of ${f.candidateCount} (${done} done) · ${elapsed}s`;
  }
  const done = f.candidatesDone ?? 0;
  return `Running — ${done} of ${f.candidateCount} candidates responding · ${elapsed}s`;
}
