import { useEffect, useState } from "react";
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
import { api, type Stats, type Activity } from "../api";
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

  const k = stats?.kpis;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Usage dashboard</h2>
        <button className="btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

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
