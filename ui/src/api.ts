// Typed fetch wrappers for the OpenFusion REST API (same origin: http://localhost:9077).
export interface CandidateSlot {
  id: string;
  provider: string;
  model: string;
  enabled: boolean;
}
export interface JudgeConfig {
  provider: string;
  model: string;
  enabled: boolean;
}
export interface AppConfig {
  version: number;
  candidates: CandidateSlot[];
  judges: JudgeConfig[];
  settings: { workerTimeoutMs: number; uiPort: number; bind: string; benchmarkMode: boolean; activePersona: string; executionMode: "parallel" | "sequential" };
  configured: boolean;
}

export interface Persona {
  id: string;
  name: string;
  description?: string;
  builtin?: boolean;
  workerPrompt: string;
  analysisPrompt: string;
  synthesisPrompt: string;
}
export interface SecretsView {
  providers: Record<string, { present: boolean; hint: string | null }>;
  referenced: string[];
  /** Provider ids that don't require an API key (e.g. rapid-mlx). */
  keyless: string[];
}
export interface ProviderModel {
  id: string;
  contextWindow?: number;
  reasoning?: boolean | string;
  cost?: { input?: number; output?: number };
}
export interface ProviderInfo {
  id: string;
  name: string;
  description?: string;
  keyless: boolean;
  /** Whether this provider supports /v1/models discovery. */
  discoverable: boolean;
  /** Whether this is a local provider that may be unreachable. */
  local: boolean;
}
export interface TestResult {
  ok: boolean;
  latencyMs: number;
  usage?: { input: number; output: number };
  error?: string;
}
export interface SubCall {
  id: string;
  activity_id: string;
  role: "worker" | "judge_analysis" | "judge_synthesis";
  slot_id?: string | null;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  latency_ms: number;
  status: "ok" | "timeout" | "error";
  error?: string | null;
  /** Generated text (worker output / judge synthesized answer). null for failures or analysis step. */
  generated_text?: string | null;
  /** Structured analysis (judge_analysis only), as a JSON string. */
  analysis_json?: string | null;
}
export interface Activity {
  id: string;
  created_at: string;
  prompt_excerpt?: string;
  has_context: number;
  candidate_count: number;
  survivor_count: number;
  judge_provider?: string;
  judge_model?: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost: number;
  total_latency_ms: number;
  status: string;
  error?: string | null;
  /** Persona id/name used for this fusion (null for pre-0.2.1 fusions). */
  persona?: string | null;
  /**
   * HOW the persona was chosen (feature 006; null for pre-0.3.0 fusions):
   * active | override | strict-enforced | invalid-fallback. Rendered as a chip suffix.
   */
  persona_source?: string | null;
  sub_calls?: SubCall[];
}
export interface Stats {
  kpis: {
    fusionCount: number;
    totalCost: number;
    totalTokens: number;
    avgLatencyMs: number;
    successRate: number;
  };
  costByModel: { model: string; cost: number }[];
  tokensByModel: { model: string; tokens: number }[];
  fusionsByDay: { day: string; count: number }[];
}

/** Live fusion-engine status (feature 007, GET /api/runtime — distinct from /api/status). */
export interface ActiveFusion {
  activityId: string;
  mode: "parallel" | "sequential";
  candidateCount: number;
  /** Sequential only: which candidate is currently running (1-indexed). */
  candidateIndex?: number;
  /** Sequential: how many resolved. Parallel: how many responding so far. */
  candidatesDone?: number;
  /** Current phase — same-process only; undefined for cross-process (DB-only) fusions. */
  phase?: "fan-out" | "analysis" | "synthesis";
  /** Epoch ms — when the fusion entered the registry. */
  startedAt: number;
}
export interface FusionRuntimeStatus {
  state: "idle" | "in-progress" | "queued";
  fusions: ActiveFusion[];
}

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}
async function sendJSON<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export const api = {
  getConfig: () => getJSON<AppConfig>("/api/config"),
  putConfig: (cfg: Partial<AppConfig>) => sendJSON<AppConfig>("PUT", "/api/config", cfg),
  getSecrets: () => getJSON<SecretsView>("/api/secrets"),
  putSecret: (provider: string, apiKey: string | null) =>
    sendJSON<SecretsView>("PUT", "/api/secrets", { provider, apiKey }),
  getProviders: () => getJSON<{ providers: ProviderInfo[] }>("/api/providers"),
  getModels: (provider: string) =>
    getJSON<{ models: ProviderModel[] }>(`/api/providers/${encodeURIComponent(provider)}/models`),
  /** Discover models from a custom provider's /v1/models endpoint. */
  discoverModels: (provider: string) =>
    getJSON<{ models: string[] }>(`/api/providers/${encodeURIComponent(provider)}/discover`),
  testProvider: (provider: string, model: string, apiKey: string) =>
    sendJSON<TestResult>("POST", "/api/test", { provider, model, apiKey }),
  getStats: (filters?: Record<string, string>) => {
    const q = filters ? "?" + new URLSearchParams(filters).toString() : "";
    return getJSON<Stats>(`/api/stats${q}`);
  },
  /** Live fusion-engine status (feature 007). Polled by the Dashboard status widget. */
  getStatus: () => getJSON<FusionRuntimeStatus>("/api/runtime"),
  getActivity: (opts: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams({
      limit: String(opts.limit ?? 25),
      offset: String(opts.offset ?? 0),
    }).toString();
    return getJSON<{ total: number; limit: number; offset: number; items: Activity[] }>(
      `/api/activity?${q}`,
    );
  },
  getActivityDetail: (id: string) => getJSON<Activity>(`/api/activity/${id}`),
  getPersonas: () => getJSON<{ personas: Persona[]; activePersona: string; personaPolicy: "strict" | "allow-override" }>("/api/personas"),
  createPersona: (p: Omit<Persona, "id">) => sendJSON<Persona>("POST", "/api/personas", p),
  updatePersona: (id: string, patch: Partial<Persona> | { reset: true }) =>
    sendJSON<Persona>("PUT", `/api/personas/${encodeURIComponent(id)}`, patch),
  deletePersona: (id: string) =>
    fetch(`/api/personas/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => r.ok),
  /** Failed/partial activities only (client-side filter — volume is low). */
  getErrors: async (opts: { limit?: number; offset?: number } = {}): Promise<{ total: number; items: Activity[] }> => {
    const r = await api.getActivity({ limit: opts.limit ?? 100, offset: opts.offset ?? 0 });
    return { total: r.items.filter((a) => a.status !== "success").length, items: r.items.filter((a) => a.status !== "success") };
  },
};

/** Copy text to the clipboard, returning false if unavailable (e.g. insecure context). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
