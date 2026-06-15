import { useEffect, useState } from "react";
import { api, type AppConfig, type SecretsView, type TestResult } from "../api";

export function ApiKeysPage({ config }: { config: AppConfig | null }) {
  const [secrets, setSecrets] = useState<SecretsView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () => void api.getSecrets().then(setSecrets);
  useEffect(refresh, [config]);

  const referenced = secrets?.referenced ?? [];

  const save = async (provider: string) => {
    setMsg(null);
    try {
      const next = await api.putSecret(provider, drafts[provider] ?? null);
      setSecrets(next);
      setDrafts((d) => ({ ...d, [provider]: "" }));
      setMsg(`Saved key for ${provider}.`);
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    }
  };

  const test = async (provider: string) => {
    setTesting(provider);
    setResults((r) => ({ ...r, [provider]: undefined as never }));
    try {
      const model =
        config?.candidates.find((c) => c.provider === provider)?.model ?? config?.judge.model ?? "";
      const key = drafts[provider] ?? "";
      const res = await api.testProvider(provider, model, key);
      setResults((r) => ({ ...r, [provider]: res }));
    } catch (e) {
      setResults((r) => ({ ...r, [provider]: { ok: false, latencyMs: 0, error: (e as Error).message } }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <section className="glass p-6">
      <h2 className="mb-1 text-lg font-semibold">API keys</h2>
      <p className="mb-4 text-sm text-white/60">
        One key per provider, shared across every candidate and the judge that reference it. Keys are
        encrypted at rest (AES-256-GCM) and never returned unmasked.
      </p>
      {msg && <p className="mb-3 text-sm text-white/70">{msg}</p>}
      <div className="space-y-3">
        {referenced.length === 0 && (
          <p className="text-sm text-white/50">No providers referenced yet — configure candidates and a judge first.</p>
        )}
        {referenced.map((p) => {
          const entry = secrets?.providers[p];
          const result = results[p];
          return (
            <div key={p} className="glass-soft p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-medium">{p}</span>
                {entry?.present ? (
                  <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-300">
                    set · {entry.hint}
                  </span>
                ) : (
                  <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300">missing</span>
                )}
              </div>
              <div className="flex gap-2">
                <input
                  className="field flex-1"
                  type="password"
                  placeholder={entry?.present ? "Enter a new key to replace…" : "Paste API key…"}
                  value={drafts[p] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p]: e.target.value }))}
                />
                <button className="btn" onClick={() => void test(p)} disabled={testing === p || !(drafts[p])}>
                  {testing === p ? "Testing…" : "Test"}
                </button>
                <button className="btn btn-primary" onClick={() => void save(p)} disabled={!drafts[p]}>
                  Save
                </button>
              </div>
              {result && (
                <p className={`mt-2 text-xs ${result.ok ? "text-emerald-300" : "text-red-300"}`}>
                  {result.ok
                    ? `✓ Connected in ${result.latencyMs}ms`
                    : `✗ ${result.error ?? "failed"}`}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
