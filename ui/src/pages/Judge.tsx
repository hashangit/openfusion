import { useEffect, useState } from "react";
import { api, type AppConfig, type ProviderModel } from "../api";

export function JudgePage({ config, onChanged }: { config: AppConfig | null; onChanged: () => void }) {
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [providers, setProviders] = useState<string[]>([]);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (config?.judge) {
      setProvider(config.judge.provider);
      setModel(config.judge.model);
    }
  }, [config]);
  useEffect(() => {
    void api.getProviders().then((r) => setProviders(r.providers));
  }, []);
  useEffect(() => {
    if (!provider) return;
    void api.getModels(provider).then((r) => setModels(r.models)).catch(() => setModels([]));
  }, [provider]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api.putConfig({ candidates: config!.candidates, judge: { provider, model } });
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
      <h2 className="mb-1 text-lg font-semibold">Judge model</h2>
      <p className="mb-4 text-sm text-white/60">
        Used for both analysis and synthesis steps (same provider/model — Constitution II).
      </p>
      {msg && <p className="mb-3 text-sm text-white/70">{msg}</p>}
      <div className="flex items-center gap-3">
        <select className="field w-44" value={provider} onChange={(e) => { setProvider(e.target.value); setModel(""); }}>
          {providers.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select className="field flex-1" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">Select a model…</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
              {m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k ctx` : ""}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" onClick={save} disabled={saving || !provider || !model}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}
