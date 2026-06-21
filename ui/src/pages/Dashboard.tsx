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

  const running = status && status.state !== "idle" ? status.fusions : [];

  return (
    <section className="glass p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {running.length > 0 && <span className={`inline-block h-2 w-2 rounded-full ${dot} animate-pulse`} />}
          {running.length === 0 && <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />}
          <h3 className="text-sm font-medium text-white/80">
            {running.length === 0
              ? "Idle"
              : running.length > 1
                ? `${running.length} fusions active`
                : "Running"}
          </h3>
        </div>
        {running.length > 0 && (
          <span className="text-xs text-white/40">live · 2s</span>
        )}
      </div>

      {running.length === 0 ? (
        <p className="mt-2 text-sm text-white/50">No fusion running.</p>
      ) : (
        <div className={running.length > 1 ? "mt-3 space-y-3" : "mt-3"}>
          {running.map((f) => (
            <PhaseBar key={f.activityId} fusion={f} compact={running.length > 1} />
          ))}
        </div>
      )}
    </section>
  );
}

const PHASES = ["fan-out", "analysis", "synthesis"] as const;
const PHASE_LABELS: Record<string, string> = {
  "fan-out": "Fan-out",
  analysis: "Analysis",
  synthesis: "Synthesis",
};

/**
 * One fusion's progress affordance: a segmented phase bar + candidate dot-row.
 * - phase known (same-process): 3-segment bar with completed/active/pending states.
 * - phase unknown (cross-process): a single indeterminate shimmer bar.
 * Compact mode (queued, >1 fusion) trims the candidate row.
 */
function PhaseBar({ fusion: f, compact }: { fusion: ActiveFusion; compact?: boolean }) {
  const elapsed = Math.max(0, Math.round((Date.now() - f.startedAt) / 1000));
  const done = f.candidatesDone ?? 0;
  const phaseKnown = f.phase !== undefined;
  const activeIdx = phaseKnown ? PHASES.indexOf(f.phase!) : -1;

  // Candidate dots: teal for done/responding, white/15 for pending, ringed for the
  // currently-running sequential candidate.
  const dots = Array.from({ length: f.candidateCount }, (_, i) => {
    const isDone = i < done;
    const isActive = f.mode === "sequential" && i + 1 === f.candidateIndex;
    return (
      <span
        key={i}
        className={`inline-block h-2 w-2 rounded-full ${
          isDone
            ? "bg-[#4cd0b0]"
            : isActive
              ? "bg-[#4cd0b0]/40 ring-1 ring-[#4cd0b0] animate-pulse"
              : "bg-white/15"
        }`}
      />
    );
  });

  return (
    <div className="rounded-lg bg-white/[0.03] p-3">
      {/* Header: mode + phase label + elapsed */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/60">
          {f.mode}
          {phaseKnown ? ` · ${PHASE_LABELS[f.phase!]}` : " · phase unknown"}
        </span>
        <span className="text-xs text-white/40">{elapsed}s</span>
      </div>

      {phaseKnown ? (
        <>
          {/* Segmented phase bar: 3 segments, completed fill with brand gradient,
              active pulses, pending stays on track. */}
          <div className="mt-2 flex gap-1">
            {PHASES.map((ph, i) => {
              const completed = i < activeIdx;
              const active = i === activeIdx;
              // Within the active fan-out segment, partial fill = candidate progress.
              const fanoutFill =
                active && ph === "fan-out" && f.candidateCount > 0
                  ? Math.min(1, done / f.candidateCount)
                  : active
                    ? 0.5
                    : 0;
              return (
                <div key={ph} className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                  {(completed || active) && (
                    <div
                      className={`absolute inset-y-0 left-0 rounded-full ${
                        active ? "animate-pulse" : ""
                      }`}
                      style={{
                        width: `${(completed ? 1 : fanoutFill) * 100}%`,
                        background: "linear-gradient(135deg, #4cd0b0, #3498db)",
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {/* Phase labels with state glyphs */}
          <div className="mt-1.5 flex justify-between">
            {PHASES.map((ph, i) => (
              <span
                key={ph}
                className={`flex-1 text-center text-[10px] ${
                  i < activeIdx
                    ? "text-[#4cd0b0]"
                    : i === activeIdx
                      ? "text-white/80"
                      : "text-white/30"
                }`}
              >
                {i < activeIdx ? "✓" : i === activeIdx ? "●" : "○"} {PHASE_LABELS[ph]}
              </span>
            ))}
          </div>
        </>
      ) : (
        // Cross-process / phase unknown: a single indeterminate shimmer bar.
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full w-1/3 animate-pulse rounded-full"
            style={{ background: "linear-gradient(135deg, #4cd0b0, #3498db)" }}
          />
        </div>
      )}

      {/* Candidate dot-row (hidden in compact/queued mode) */}
      {!compact && (
        <div className="mt-2.5 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-white/35">
            {f.mode === "sequential" ? "Candidates" : "Responding"}
          </span>
          <div className="flex items-center gap-1.5">
            <div className="flex items-center gap-1">{dots}</div>
            <span className="ml-1 text-[10px] text-white/40">
              ({done} of {f.candidateCount})
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
