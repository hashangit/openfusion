import { useEffect, useState } from "react";
import { api, type AppConfig, type CandidateSlot, type ProviderModel } from "../api";

export function CandidatesPage({
  config,
  onChanged,
}: {
  config: AppConfig | null;
  onChanged: () => void;
}) {
  const [candidates, setCandidates] = useState<CandidateSlot[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ProviderModel[]>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (config) setCandidates(config.candidates);
  }, [config]);

  useEffect(() => {
    void api.getProviders().then((r) => setProviders(r.providers));
  }, []);

  const loadModels = async (provider: string) => {
    if (modelsByProvider[provider]) return;
    try {
      const r = await api.getModels(provider);
      setModelsByProvider((m) => ({ ...m, [provider]: r.models }));
    } catch {
      /* ignore */
    }
  };

  const update = (id: string, patch: Partial<CandidateSlot>) => {
    setCandidates((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    if (patch.provider) void loadModels(patch.provider);
  };
  const add = () => {
    if (candidates.length >= 5) return;
    setCandidates((cs) => [...cs, { id: `c${cs.length + 1}-${Date.now()}`, provider: providers[0] ?? "", model: "" }]);
  };
  const remove = (id: string) => {
    if (candidates.length <= 2) return;
    setCandidates((cs) => cs.filter((c) => c.id !== id));
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const out: Partial<AppConfig> & { candidates: CandidateSlot[]; judge: AppConfig["judge"] } = {
        candidates,
        judge: config!.judge,
      };
      await api.putConfig(out);
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
            {candidates.length} of 5 slots · minimum 2 required for fusion.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={add} disabled={candidates.length >= 5}>
            + Add
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving || candidates.length < 2}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {candidates.length < 2 && (
        <p className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          Add at least 2 candidates.
        </p>
      )}
      {msg && <p className="mb-3 text-sm text-white/70">{msg}</p>}

      <div className="space-y-2">
        {candidates.map((c, i) => {
          const models = modelsByProvider[c.provider] ?? [];
          return (
            <div key={c.id} className="glass-soft flex items-center gap-3 p-3">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10 text-xs">{i + 1}</span>
              <select
                className="field w-40"
                value={c.provider}
                onChange={(e) => update(c.id, { provider: e.target.value, model: "" })}
              >
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <select
                className="field flex-1"
                value={c.model}
                onChange={(e) => update(c.id, { model: e.target.value })}
                onFocus={() => void loadModels(c.provider)}
              >
                <option value="">{models.length ? "Select a model…" : "Focus to load…"}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                    {m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k ctx` : ""}
                  </option>
                ))}
              </select>
              <button className="btn" onClick={() => remove(c.id)} disabled={candidates.length <= 2}>
                Remove
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
