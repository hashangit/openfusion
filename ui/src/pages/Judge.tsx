import { useEffect, useState } from "react";
import { api, type AppConfig, type JudgeConfig, type ProviderInfo, type ProviderModel } from "../api";

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

export function JudgePage({ config, onChanged }: { config: AppConfig | null; onChanged: () => void }) {
  const [judges, setJudges] = useState<JudgeConfig[]>([]);
  const [providerList, setProviderList] = useState<ProviderInfo[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ProviderModel[]>>({});
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  /** Discovered model IDs for local providers (keyed by provider). */
  const [discoveredByProvider, setDiscoveredByProvider] = useState<Record<string, string[]>>({});
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Provider id list for defaults.
  const providers = providerList.map((p) => p.id);
  const providerMap = new Map(providerList.map((p) => [p.id, p]));

  useEffect(() => {
    if (config) setJudges(config.judges);
  }, [config]);
  useEffect(() => {
    void api.getProviders().then((r) => setProviderList(r.providers));
  }, []);

  // Eagerly load models for all providers referenced in the current config.
  // This ensures saved model names appear immediately, not as "Focus to load…".
  useEffect(() => {
    if (!config) return;
    const providers = new Set<string>();
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

  // Exactly one enabled: turning one on makes it the sole enabled judge.
  const toggle = (idx: number, on: boolean) => {
    setJudges((js) => js.map((j, i) => ({ ...j, enabled: on ? i === idx : i === idx ? false : j.enabled })));
  };
  const update = (idx: number, patch: Partial<JudgeConfig>) => {
    setJudges((js) => js.map((j, i) => (i === idx ? { ...j, ...patch } : j)));
    if (patch.provider) void loadModels(patch.provider);
  };
  const add = () => {
    setJudges((js) => [...js, { provider: providers[0] ?? "", model: "", enabled: false }]);
  };
  const remove = (idx: number) => {
    setJudges((js) => js.filter((_, i) => i !== idx));
  };

  const enabledCount = judges.filter((j) => j.enabled).length;
  const rangeError =
    enabledCount === 0
      ? "Enable exactly 1 judge (currently 0 enabled)."
      : enabledCount > 1
        ? `Only 1 judge can be enabled (currently ${enabledCount}).`
        : null;

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api.putConfig({ judges, candidates: config!.candidates });
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
      <div className="mb-1 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Judge models</h2>
          <p className="text-sm text-white/60">
            Configure as many as you like; enable exactly one. The enabled judge runs both analysis and synthesis (same model — Constitution II).
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={add}>
            + Add
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !!rangeError}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {rangeError && (
        <p className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{rangeError}</p>
      )}
      {msg && <p className="mb-3 text-sm text-white/70">{msg}</p>}

      <div className="mt-4 space-y-2">
        {judges.map((j, i) => {
          const pInfo = providerMap.get(j.provider);
          const isLocal = pInfo?.local ?? false;
          const models = modelsByProvider[j.provider] ?? [];
          const isLoading = loadingProvider === j.provider;
          const discovered = discoveredByProvider[j.provider] ?? [];
          // For local discoverable providers, merge discovered models into the list.
          const allModels: ProviderModel[] = isLocal && discovered.length > 0
            ? mergeModelLists(discovered.map((id) => ({ id })), models)
            : models;
          // If the saved model isn't in the list yet, add it as an option so it's visible.
          const displayModels = j.model && !allModels.some((m) => m.id === j.model)
            ? [{ id: j.model }, ...allModels]
            : allModels;
          return (
            <div key={i} className={`glass-soft flex items-center gap-3 p-3 ${j.enabled ? "" : "opacity-50"}`}>
              <div
                className={`toggle ${j.enabled ? "on" : ""}`}
                role="switch"
                aria-checked={j.enabled}
                title={j.enabled ? "Enabled (active judge)" : "Disabled"}
                onClick={() => toggle(i, !j.enabled)}
              />
              <select
                className="field w-44"
                value={j.provider}
                onChange={(e) => update(i, { provider: e.target.value, model: "" })}
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
                    list={`judge-models-${j.provider}`}
                    placeholder={discovered.length ? "Select or type a model…" : "Type a model ID…"}
                    value={j.model}
                    onChange={(e) => update(i, { model: e.target.value })}
                  />
                  <datalist id={`judge-models-${j.provider}`}>
                    {discovered.map((id) => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                  <button
                    className="btn text-xs whitespace-nowrap"
                    onClick={() => void discoverModels(j.provider)}
                    disabled={discovering === j.provider}
                  >
                    {discovering === j.provider ? "Discovering…" : "Discover"}
                  </button>
                </div>
              ) : (
                /* Built-in and cloud providers: dropdown with saved model always visible */
                <select
                  className="field flex-1"
                  value={j.model}
                  onChange={(e) => update(i, { model: e.target.value })}
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
              <button className="btn" onClick={() => remove(i)} disabled={judges.length <= 1}>
                Remove
              </button>
            </div>
          );
        })}
        {judges.length === 0 && (
          <p className="text-sm text-white/50">No judges configured — click "+ Add".</p>
        )}
      </div>
    </section>
  );
}