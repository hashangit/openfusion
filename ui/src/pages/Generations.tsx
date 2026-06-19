import { useEffect, useState } from "react";
import { api, type Activity, type SubCall } from "../api";
import { GenerationText } from "../components/GenerationText";

type ViewMode = "candidates" | "judge";

interface AnalysisShape {
  consensus?: string[];
  contradictions?: string[];
  partialCoverage?: string[];
  uniqueInsights?: string[];
  blindSpots?: string[];
}

export function GenerationsPage() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [detail, setDetail] = useState<Activity | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [view, setView] = useState<ViewMode>("candidates");

  // Load recent activities for the dropdown.
  useEffect(() => {
    void api.getActivity({ limit: 50 }).then((r) => {
      setActivities(r.items);
      if (r.items.length && !selectedId) setSelectedId(r.items[0].id);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the selected activity's full detail (with sub_calls).
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    api
      .getActivityDetail(selectedId)
      .then(setDetail)
      .finally(() => setLoadingDetail(false));
  }, [selectedId]);

  const workers: SubCall[] = (detail?.sub_calls ?? []).filter((s) => s.role === "worker");
  const analysis = (detail?.sub_calls ?? []).find((s) => s.role === "judge_analysis");
  const synthesis = (detail?.sub_calls ?? []).find((s) => s.role === "judge_synthesis");
  const predatesLogging = (detail?.sub_calls ?? []).every(
    (s) => !s.generated_text && !s.analysis_json,
  );

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Generations</h2>
      <p className="-mt-2 text-sm text-white/60">
        Read what each model produced for a fusion, side by side.
      </p>

      {/* Top controls */}
      <div className="glass flex flex-wrap items-center gap-3 p-3">
        <label className="text-xs text-white/50">Activity</label>
        <select
          className="field min-w-[16rem] flex-1"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          disabled={activities.length === 0}
        >
          {activities.length === 0 && <option value="">No fusions yet</option>}
          {activities.map((a) => (
            <option key={a.id} value={a.id}>
              {new Date(a.created_at).toLocaleString()} · {a.survivor_count}/{a.candidate_count} ·{" "}
              {(a.prompt_excerpt || "(no prompt)").slice(0, 60)}
            </option>
          ))}
        </select>
        <label className="text-xs text-white/50">View</label>
        <select className="field w-36" value={view} onChange={(e) => setView(e.target.value as ViewMode)}>
          <option value="candidates">Candidates</option>
          <option value="judge">Judge</option>
        </select>
        {detail?.persona && (
          <span
            className="rounded-full border border-[#4cd0b0]/40 bg-[#4cd0b0]/10 px-2.5 py-1 text-xs text-[#4cd0b0]"
            title={`Persona used for this fusion${detail.persona_source ? ` (source: ${detail.persona_source})` : ""}`}
          >
            ◈ {detail.persona}
            {detail.persona_source === "override" && " (client override)"}
            {detail.persona_source === "strict-enforced" && " (strict-enforced)"}
            {detail.persona_source === "invalid-fallback" && " (invalid-fallback)"}
          </span>
        )}
      </div>

      {loadingDetail && <p className="text-sm text-white/50">Loading…</p>}

      {!loadingDetail && detail && predatesLogging && (
        <div className="glass p-4 text-sm text-amber-200">
          Generation text wasn't recorded for this fusion (it predates generation logging).
        </div>
      )}

      {!loadingDetail && detail && !predatesLogging && view === "candidates" && (
        <CandidatesView workers={workers} />
      )}

      {!loadingDetail && detail && !predatesLogging && view === "judge" && (
        <JudgeView analysis={analysis} synthesis={synthesis} />
      )}
    </div>
  );
}

/** Horizontally-scrollable row of candidate boxes; each box picks a candidate via dropdown. */
function CandidatesView({ workers }: { workers: SubCall[] }) {
  // Each box holds an index into the workers array. Default: first two.
  const [boxes, setBoxes] = useState<number[]>([0, 1]);

  // Reset to defaults when the set of workers changes (new activity selected).
  useEffect(() => {
    setBoxes(workers.length >= 2 ? [0, 1] : workers.length === 1 ? [0] : []);
  }, [workers]);

  if (workers.length === 0) {
    return <div className="glass p-4 text-sm text-white/50">No candidate generations for this fusion.</div>;
  }

  const addBox = () => setBoxes((b) => [...b, Math.min(b.length, workers.length - 1)]);
  const setBox = (i: number, workerIdx: number) =>
    setBoxes((b) => b.map((v, idx) => (idx === i ? workerIdx : v)));
  const removeBox = (i: number) => setBoxes((b) => (b.length <= 1 ? b : b.filter((_, idx) => idx !== i)));

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs text-white/50">{workers.length} candidate generation(s) · scroll ↔ to compare more</p>
        <button className="btn" onClick={addBox} disabled={boxes.length >= workers.length}>
          + Add box
        </button>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-3">
        {boxes.map((workerIdx, boxIdx) => {
          const w = workers[workerIdx];
          if (!w) return null;
          return (
            <div key={boxIdx} className="glass-soft flex w-[22rem] min-w-0 flex-shrink-0 flex-col p-3">
              <div className="mb-2 flex items-center gap-2">
                <select
                  className="field min-w-0 flex-1 truncate text-xs"
                  value={workerIdx}
                  onChange={(e) => setBox(boxIdx, Number(e.target.value))}
                >
                  {workers.map((ww, i) => (
                    <option key={ww.id} value={i}>
                      {ww.slot_id ?? `candidate ${i + 1}`} · {ww.provider}/{ww.model}
                    </option>
                  ))}
                </select>
                {boxes.length > 1 && (
                  <button
                    className="btn-icon flex-shrink-0"
                    onClick={() => removeBox(boxIdx)}
                    title="Remove box"
                    aria-label="Remove box"
                  >
                    ✕
                  </button>
                )}
              </div>
              <div className="mb-2 min-h-0 flex-1 max-h-96 overflow-y-auto pr-1">
                <GenerationText text={w.generated_text ?? ""} />
              </div>
              <SubCallStats s={w} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Single box: the judge's structured analysis + synthesized answer, with stats. */
function JudgeView({ analysis, synthesis }: { analysis?: SubCall; synthesis?: SubCall }) {
  const parsed: AnalysisShape | null = analysis?.analysis_json
    ? safeParse(analysis.analysis_json)
    : null;
  return (
    <div className="space-y-3">
      {analysis && (
        <div className="glass-soft p-4">
          <h3 className="mb-2 text-sm font-medium text-[#4cd0b0]">Judge analysis</h3>
          {parsed ? (
            <div className="space-y-2 text-sm">
              <AnalysisField label="Consensus" items={parsed.consensus} />
              <AnalysisField label="Contradictions" items={parsed.contradictions} />
              <AnalysisField label="Partial coverage" items={parsed.partialCoverage} />
              <AnalysisField label="Unique insights" items={parsed.uniqueInsights} />
              <AnalysisField label="Blind spots" items={parsed.blindSpots} />
            </div>
          ) : (
            <p className="text-sm italic text-white/40">Analysis not recorded.</p>
          )}
          <div className="mt-3 border-t border-white/10 pt-2">
            <SubCallStats s={analysis} />
          </div>
        </div>
      )}
      {synthesis && (
        <div className="glass-soft p-4">
          <h3 className="mb-2 text-sm font-medium text-[#4cd0b0]">Judge synthesis (final answer)</h3>
          <div className="max-h-[40rem] overflow-y-auto pr-1">
            <GenerationText text={synthesis.generated_text ?? ""} />
          </div>
          <div className="mt-3 border-t border-white/10 pt-2">
            <SubCallStats s={synthesis} />
          </div>
        </div>
      )}
      {!analysis && !synthesis && (
        <div className="glass p-4 text-sm text-white/50">No judge generation for this fusion.</div>
      )}
    </div>
  );
}

function AnalysisField({ label, items }: { label: string; items?: string[] }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-white/40">{label}</p>
      {items && items.length ? (
        <ul className="ml-4 list-disc text-white/80">
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      ) : (
        <p className="text-white/40">—</p>
      )}
    </div>
  );
}

function SubCallStats({ s }: { s: SubCall }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[0.7rem] text-white/50">
      <span>{s.provider}/{s.model}</span>
      <span>·</span>
      <span>tokens {s.input_tokens}/{s.output_tokens}</span>
      <span>·</span>
      <span>${s.cost.toFixed(5)}</span>
      <span>·</span>
      <span>{(s.latency_ms / 1000).toFixed(1)}s</span>
      <span>·</span>
      <span className={s.status === "ok" ? "text-emerald-300" : "text-red-300"}>{s.status}</span>
    </div>
  );
}

function safeParse(s: string): AnalysisShape | null {
  try {
    return JSON.parse(s) as AnalysisShape;
  } catch {
    return null;
  }
}
