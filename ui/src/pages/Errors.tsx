import { useEffect, useState } from "react";
import { api, copyText, type Activity } from "../api";
import { ActivityTable } from "../components/ActivityTable";

export function ErrorsPage() {
  const [items, setItems] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Error log</h2>
          <p className="text-sm text-white/60">Failed and partial fusions — for troubleshooting. Use the copy icon to grab the full JSON of an activity.</p>
        </div>
        <button className="btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-white/50">Loading…</p>
      ) : items.length === 0 ? (
        <section className="glass p-6">
          <p className="text-sm text-emerald-300">✓ No errors. All fusions succeeded.</p>
        </section>
      ) : (
        <>
          {/* Compact error list with copy buttons */}
          <section className="glass p-4">
            <h3 className="mb-3 text-sm font-medium text-white/70">{items.length} failed/partial</h3>
            <div className="space-y-2">
              {items.map((a) => (
                <div key={a.id} className="glass-soft flex items-start gap-3 p-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 text-xs text-white/50">
                      <span>{new Date(a.created_at).toLocaleString()}</span>
                      <span className={a.status === "error" ? "text-red-300" : "text-amber-300"}>{a.status}</span>
                      <span>· {a.survivor_count}/{a.candidate_count} survivors</span>
                    </div>
                    <p className="mt-1 truncate text-sm text-white/80">{a.prompt_excerpt}</p>
                    {a.error && (
                      <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-xs text-red-200">
                        {a.error}
                      </pre>
                    )}
                  </div>
                  <button
                    className={`btn-icon ${copiedId === a.id ? "copied" : ""}`}
                    onClick={() => void copy(a)}
                    title="Copy full activity JSON"
                  >
                    {copiedId === a.id ? "✓ Copied" : "Copy"}
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* Expandable detail (reuses the dashboard's ActivityTable) */}
          <section className="glass p-4">
            <h3 className="mb-3 text-sm font-medium text-white/70">Expandable detail</h3>
            <ActivityTable items={items} />
          </section>
        </>
      )}
    </div>
  );
}
