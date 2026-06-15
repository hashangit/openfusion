import { useState } from "react";
import { api, type Activity, type SubCall } from "../api";

const STATUS_COLOR: Record<string, string> = {
  success: "text-emerald-300",
  partial: "text-amber-300",
  error: "text-red-300",
  ok: "text-emerald-300",
  timeout: "text-amber-300",
};

export function ActivityTable({ items }: { items: Activity[] }) {
  const [expanded, setExpanded] = useState<Record<string, Activity>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const toggle = async (a: Activity) => {
    if (expanded[a.id]) {
      setExpanded((e) => {
        const next = { ...e };
        delete next[a.id];
        return next;
      });
      return;
    }
    setLoadingId(a.id);
    try {
      const detail = await api.getActivityDetail(a.id);
      setExpanded((e) => ({ ...e, [a.id]: detail }));
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-white/50">
            <th className="py-2 pr-3">When</th>
            <th className="py-2 pr-3">Prompt</th>
            <th className="py-2 pr-3">Survivors</th>
            <th className="py-2 pr-3">Judge</th>
            <th className="py-2 pr-3">Cost</th>
            <th className="py-2 pr-3">Latency</th>
            <th className="py-2 pr-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <>
              <tr
                key={a.id}
                className="cursor-pointer border-t border-white/5 hover:bg-white/5"
                onClick={() => void toggle(a)}
              >
                <td className="py-2 pr-3 text-white/60">{new Date(a.created_at).toLocaleString()}</td>
                <td className="max-w-xs truncate py-2 pr-3 text-white/80">{a.prompt_excerpt}</td>
                <td className="py-2 pr-3">
                  {a.survivor_count}/{a.candidate_count}
                </td>
                <td className="py-2 pr-3 text-white/60">{a.judge_model}</td>
                <td className="py-2 pr-3">${a.total_cost.toFixed(4)}</td>
                <td className="py-2 pr-3">{(a.total_latency_ms / 1000).toFixed(1)}s</td>
                <td className={`py-2 pr-3 font-medium ${STATUS_COLOR[a.status] ?? "text-white/60"}`}>
                  {a.status}
                </td>
              </tr>
              {expanded[a.id] && (
                <tr key={`${a.id}-detail`} className="border-t border-white/5">
                  <td colSpan={7} className="bg-black/20 px-4 py-3">
                    {loadingId === a.id ? (
                      <p className="text-xs text-white/50">Loading…</p>
                    ) : (
                      <SubCallTable subCalls={expanded[a.id].sub_calls ?? []} />
                    )}
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SubCallTable({ subCalls }: { subCalls: SubCall[] }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-white/60">
        Sub-calls ({subCalls.length}) — the activity as a dimension
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-white/40">
            <th className="py-1 pr-3">Role</th>
            <th className="py-1 pr-3">Provider/Model</th>
            <th className="py-1 pr-3">Tokens (in/out)</th>
            <th className="py-1 pr-3">Cost</th>
            <th className="py-1 pr-3">Latency</th>
            <th className="py-1 pr-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {subCalls.map((s) => (
            <tr key={s.id} className="border-t border-white/5">
              <td className="py-1 pr-3 font-mono text-white/70">{s.role}</td>
              <td className="py-1 pr-3 text-white/60">
                {s.provider}/{s.model}
              </td>
              <td className="py-1 pr-3 text-white/60">
                {s.input_tokens}/{s.output_tokens}
              </td>
              <td className="py-1 pr-3 text-white/60">${s.cost.toFixed(5)}</td>
              <td className="py-1 pr-3 text-white/60">{(s.latency_ms / 1000).toFixed(1)}s</td>
              <td className={`py-1 pr-3 ${STATUS_COLOR[s.status] ?? "text-white/60"}`}>{s.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
