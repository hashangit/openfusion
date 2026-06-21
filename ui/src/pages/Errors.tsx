import { useEffect, useMemo, useState } from "react";
import { api, copyText, type Activity } from "../api";
import { SubCallTable } from "../components/ActivityTable";

type StatusFilter = "all" | "error" | "partial";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All (failed + partial)" },
  { value: "error", label: "Failed only" },
  { value: "partial", label: "Partial only" },
];

export function ErrorsPage() {
  const [items, setItems] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<Activity | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await api.getErrors({ limit: 100 });
      setItems(r.items);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  const copy = async (a: Activity) => {
    // Copy the full activity detail (incl. sub_calls + error) for troubleshooting.
    let payload: Activity = a;
    try {
      payload = await api.getActivityDetail(a.id);
    } catch {
      /* fall back to the list row */
    }
    const ok = await copyText(JSON.stringify(payload, null, 2));
    if (ok) {
      setCopiedId(a.id);
      setTimeout(() => setCopiedId((id) => (id === a.id ? null : id)), 1500);
    }
  };

  const toggle = async (a: Activity) => {
    if (expandedId === a.id) {
      setExpandedId(null);
      setExpandedDetail(null);
      return;
    }
    setExpandedId(a.id);
    setExpandedDetail(null);
    setLoadingId(a.id);
    try {
      const detail = await api.getActivityDetail(a.id);
      setExpandedDetail(detail);
    } finally {
      setLoadingId(null);
    }
  };

  // Client-side filtering: by status, then by free-text over prompt + error.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((a) => {
      if (statusFilter !== "all") {
        const isErr = a.status === "error";
        if (statusFilter === "error" && !isErr) return false;
        if (statusFilter === "partial" && isErr) return false;
      }
      if (!q) return true;
      const hay = `${a.prompt_excerpt ?? ""} ${a.error ?? ""} ${a.persona ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, statusFilter, query]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Error log</h2>
          <p className="text-sm text-white/60">Failed and partial fusions — for troubleshooting. Click a row to inspect sub-calls; use copy to grab the full JSON.</p>
        </div>
        <button className="btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="glass flex flex-wrap items-center gap-3 p-3">
        <label className="text-xs text-white/50">Status</label>
        <select
          className="field w-44"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <label className="text-xs text-white/50">Search</label>
        <input
          type="search"
          className="field min-w-[14rem] flex-1"
          placeholder="Filter by prompt text, error, or persona…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="text-xs text-white/40">
          {filtered.length}/{items.length}
        </span>
      </div>

      {loading ? (
        <p className="text-sm text-white/50">Loading…</p>
      ) : items.length === 0 ? (
        <section className="glass p-6">
          <p className="text-sm text-emerald-300">✓ No errors. All fusions succeeded.</p>
        </section>
      ) : filtered.length === 0 ? (
        <section className="glass p-6">
          <p className="text-sm text-white/50">No errors match the current filters.</p>
        </section>
      ) : (
        <section className="glass p-4">
          <h3 className="mb-3 text-sm font-medium text-white/70">{filtered.length} failed/partial</h3>
          <div className="space-y-2">
            {filtered.map((a) => {
              const isOpen = expandedId === a.id;
              return (
                <div key={a.id} className="glass-soft p-3">
                  <div className="flex items-start gap-3">
                    <button
                      className={`mt-0.5 flex-shrink-0 text-white/50 transition ${isOpen ? "rotate-90" : ""}`}
                      onClick={() => void toggle(a)}
                      title={isOpen ? "Collapse" : "Expand sub-calls"}
                      aria-expanded={isOpen}
                    >
                      ▶
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-white/50">
                        <span>{new Date(a.created_at).toLocaleString()}</span>
                        <span className={a.status === "error" ? "text-red-300" : "text-amber-300"}>{a.status}</span>
                        <span>· {a.survivor_count}/{a.candidate_count} survivors</span>
                        {a.persona && <span className="text-[#4cd0b0]/80">· ◈ {a.persona}</span>}
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-white/80">{a.prompt_excerpt}</p>
                      {a.error && (
                        <pre className="mt-1 max-h-24 min-w-0 overflow-auto break-all whitespace-pre-wrap rounded bg-black/30 p-2 text-xs text-red-200">
                          {a.error}
                        </pre>
                      )}
                    </div>
                    <button
                      className={`btn-icon flex-shrink-0 ${copiedId === a.id ? "copied" : ""}`}
                      onClick={() => void copy(a)}
                      title="Copy full activity JSON"
                    >
                      {copiedId === a.id ? "✓" : "⧉"}
                    </button>
                  </div>
                  {isOpen && (
                    <div className="mt-3 overflow-x-auto border-t border-white/10 pt-3">
                      {loadingId === a.id ? (
                        <p className="text-xs text-white/50">Loading…</p>
                      ) : expandedDetail ? (
                        <SubCallTable subCalls={expandedDetail.sub_calls ?? []} />
                      ) : (
                        <p className="text-xs text-white/40">No sub-call detail available.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
