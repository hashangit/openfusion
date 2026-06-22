import { useEffect, useState } from "react";
import { api, type AppConfig, type CandidateSlot, type ProviderInfo, type ProviderModel } from "../api";

/** Merge two model lists, deduplicating by id. Keeps the entry from `b` on conflict. */
function mergeModelLists(a: ProviderModel[], b: ProviderModel[]): ProviderModel[] {
  const seen = new Set<string>();
  const result: ProviderModel[] = [];
  for (const m of a) {
    if (!seen.has(m.id)) { seen.add(m.id); result.push(m); }
  }
  for (const m of b) {
    if (!seen.has(m.id)) { seen.add(m.id); result.push(m); }
  }
  return result;
}

/**
 * Serial time budget in minutes (feature 007). Mirrors the engine constants in
 * src/fusion/fanout.ts (PER_CANDIDATE_MS=180_000, JUDGE_STEPS_MS=360_000). TS constants
 * don't trivially cross the UI bundle boundary, so they're duplicated here; the agreement
 * is guarded by serial-budget.test.ts (T14). If either side changes, update BOTH + the test.
 */
const PER_CANDIDATE_MIN = 3;
const JUDGE_STEPS_MIN = 6;
function serialBudgetMinutes(enabledCount: number): number {
  return PER_CANDIDATE_MIN * enabledCount + JUDGE_STEPS_MIN;
}

export function CandidatesPage({
  config,
  onChanged,
}: {
  config: AppConfig | null;
  onChanged: () => void;
}) {
  const [candidates, setCandidates] = useState<CandidateSlot[]>([]);
  const [benchmark, setBenchmark] = useState(false);
  const [sequential, setSequential] = useState(false);
  const [providerList, setProviderList] = useState<ProviderInfo[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ProviderModel[]>>({});
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  /** Discovered model IDs for local providers (keyed by provider). */
  const [discoveredByProvider, setDiscoveredByProvider] = useState<Record<string, string[]>>({});
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Provider id list for dropdowns.
  const providers = providerList.map((p) => p.id);
  const providerMap = new Map(providerList.map((p) => [p.id, p]));

  useEffect(() => {
    if (config) {
      setCandidates(config.candidates);
      setBenchmark(config.settings.benchmarkMode);
      setSequential(config.settings.executionMode === "sequential");
    }
  }, [config]);

  useEffect(() => {
    void api.getProviders().then((r) => setProviderList(r.providers));
  }, []);

  // Eagerly load models for all providers referenced in the current config.
  // This ensures saved model names appear immediately, not as "Focus to load…".
  useEffect(() => {
    if (!config) return;
    const providers = new Set<string>();
    for (const c of config.candidates) providers.add(c.provider);
    for (const j of config.judges) providers.add(j.provider);
    for (const p of providers) {
      void loadModels(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  const loadModels = async (provider: string) => {
    if (modelsByProvider[provider]) return;
    setLoadingProvider(provider);
    try {
      const r = await api.getModels(provider);
      setModelsByProvider((m) => ({ ...m, [provider]: r.models }));
    } catch {
      /* ignore */
    } finally {
      setLoadingProvider(null);
    }
  };

  const discoverModels = async (provider: string) => {
    setDiscovering(provider);
    try {
      const r = await api.discoverModels(provider);
      setDiscoveredByProvider((d) => ({ ...d, [provider]: r.models }));
    } catch (e) {
      setMsg(`Discovery failed: ${(e as Error).message}`);
    } finally {
      setDiscovering(null);
    }
  };

  const update = (id: string, patch: Partial<CandidateSlot>) => {
    setCandidates((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    if (patch.provider) void loadModels(patch.provider);
  };
  const add = () => {
    // In benchmark mode there's no max; otherwise cap at 5.
    if (!benchmark && candidates.length >= 5) return;
    setCandidates((cs) => [
      ...cs,
      { id: `c${cs.length + 1}-${Date.now()}`, provider: providers[0] ?? "", model: "", enabled: true },
    ]);
  };
  const remove = (id: string) => {
    setCandidates((cs) => cs.filter((c) => c.id !== id));
  };

  const enabledCount = candidates.filter((c) => c.enabled).length;
  // The engine enforces the budget from the SAVED config's enabled candidates, so the helper
  // shows that (not the working-state enabledCount, which may be mid-edit). If the working
  // state differs, flag "(after Save)" so the number doesn't silently mislead.
  const savedEnabledCount = (config?.candidates ?? []).filter((c) => c.enabled).length;
  const sequentialBudgetDirty = enabledCount !== savedEnabledCount;
  const rangeError = enabledCount < 2
    ? `Need at least 2 enabled candidates (have ${enabledCount}).`
    : !benchmark && enabledCount > 5
      ? `At most 5 enabled candidates outside Benchmark Mode (have ${enabledCount}).`
      : null;

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api.putConfig({
        candidates,
        judges: config!.judges,
        settings: { ...config!.settings, benchmarkMode: benchmark, executionMode: sequential ? "sequential" : "parallel" },
      });
      setMsg("Saved.");
      onChanged();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="glass p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Candidate models</h2>
          <p className="text-sm text-white/60">
            {enabledCount} enabled{!benchmark ? ` of ${candidates.length} · 2–5 required` : " · benchmark mode (no max)"}.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={add} disabled={!benchmark && candidates.length >= 5}>
            + Add
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !!rangeError}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* Benchmark mode toggle */}
      <div className="glass-soft mb-4 flex items-center justify-between p-3">
        <div>
          <p className="text-sm font-medium">Benchmark Mode</p>
          <p className="text-xs text-white/55">
            No max candidate limit; candidate timeout forced to 10 minutes. Useful for comparing many models at once.
          </p>
        </div>
        <div
          className={`toggle ${benchmark ? "on" : ""}`}
          role="switch"
          aria-checked={benchmark}
          onClick={() => setBenchmark((b) => !b)}
        />
      </div>

      {/* Sequential mode toggle (feature 007) — opt-in for low-VRAM local setups */}
      <div className="glass-soft mb-4 flex items-center justify-between p-3">
        <div>
          <p className="text-sm font-medium">Sequential Mode</p>
          <p className="text-xs text-white/55">
            Runs candidates one at a time. Use this for fully-local setups (Ollama/llama.cpp) with limited VRAM;
            cloud-only setups should stay on Parallel (default).
          </p>
          {savedEnabledCount >= 2 && (
            <p className="text-xs text-white/45">
              Sequential: up to ~{serialBudgetMinutes(savedEnabledCount)}m total ({savedEnabledCount} candidates × 3m + 6m judging).
              {sequentialBudgetDirty && <span className="text-amber-300/70"> (after Save)</span>}
            </p>
          )}
        </div>
        <div
          className={`toggle ${sequential ? "on" : ""}`}
          role="switch"
          aria-checked={sequential}
          onClick={() => setSequential((s) => !s)}
        />
      </div>

      {rangeError && (
        <p className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{rangeError}</p>
      )}
      {msg && <p className="mb-3 text-sm text-white/70">{msg}</p>}

      <div className="space-y-2">
        {candidates.map((c, i) => {
          const pInfo = providerMap.get(c.provider);
          const isLocal = pInfo?.local ?? false;
          const models = modelsByProvider[c.provider] ?? [];
          const isLoading = loadingProvider === c.provider;
          const discovered = discoveredByProvider[c.provider] ?? [];
          // For local discoverable providers, merge discovered models into the list.
          const allModels: ProviderModel[] = isLocal && discovered.length > 0
            ? mergeModelLists(discovered.map((id) => ({ id })), models)
            : models;
          // If the saved model isn't in the list yet, add it as an option so it's visible.
          const displayModels = c.model && !allModels.some((m) => m.id === c.model)
            ? [{ id: c.model }, ...allModels]
            : allModels;
          return (
            <div key={c.id} className={`glass-soft flex items-center gap-3 p-3 ${c.enabled ? "" : "opacity-50"}`}>
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10 text-xs">{i + 1}</span>
              <div
                className={`toggle ${c.enabled ? "on" : ""}`}
                role="switch"
                aria-checked={c.enabled}
                title={c.enabled ? "Enabled" : "Disabled"}
                onClick={() => update(c.id, { enabled: !c.enabled })}
              />
              <select
                className="field w-40"
                value={c.provider}
                onChange={(e) => update(c.id, { provider: e.target.value, model: "" })}
              >
                {providerList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {isLocal ? (
                /* Local discoverable providers: free-text input + Discover button */
                <div className="flex flex-1 items-center gap-2">
                  <input
                    className="field flex-1"
                    type="text"
                    list={`models-${c.provider}`}
                    placeholder={discovered.length ? "Select or type a model…" : "Type a model ID…"}
                    value={c.model}
                    onChange={(e) => update(c.id, { model: e.target.value })}
                  />
                  <datalist id={`models-${c.provider}`}>
                    {discovered.map((id) => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                  <button
                    className="btn text-xs whitespace-nowrap"
                    onClick={() => void discoverModels(c.provider)}
                    disabled={discovering === c.provider}
                  >
                    {discovering === c.provider ? "Discovering…" : "Discover"}
                  </button>
                </div>
              ) : (
                /* Built-in and cloud providers: dropdown with saved model always visible */
                <select
                  className="field flex-1"
                  value={c.model}
                  onChange={(e) => update(c.id, { model: e.target.value })}
                >
                  <option value="">
                    {isLoading ? "Loading…" : displayModels.length ? "Select a model…" : "No models found"}
                  </option>
                  {displayModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                      {m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k ctx` : ""}
                    </option>
                  ))}
                </select>
              )}
              <button className="btn" onClick={() => remove(c.id)}>
                Remove
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}