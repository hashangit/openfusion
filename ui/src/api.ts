// Typed fetch wrappers for the OpenFusion REST API (same origin: http://localhost:9077).
export interface CandidateSlot {
  id: string;
  provider: string;
  model: string;
}
export interface JudgeConfig {
  provider: string;
  model: string;
}
export interface AppConfig {
  version: number;
  candidates: CandidateSlot[];
  judge: JudgeConfig;
  settings: { workerTimeoutMs: number; uiPort: number; bind: string };
  configured: boolean;
}
export interface SecretsView {
  providers: Record<string, { present: boolean; hint: string | null }>;
  referenced: string[];
}
export interface ProviderModel {
  id: string;
  contextWindow?: number;
  reasoning?: boolean | string;
  cost?: { input?: number; output?: number };
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
  getProviders: () => getJSON<{ providers: string[] }>("/api/providers"),
  getModels: (provider: string) =>
    getJSON<{ models: ProviderModel[] }>(`/api/providers/${encodeURIComponent(provider)}/models`),
  testProvider: (provider: string, model: string, apiKey: string) =>
    sendJSON<TestResult>("POST", "/api/test", { provider, model, apiKey }),
  getStats: (filters?: Record<string, string>) => {
    const q = filters ? "?" + new URLSearchParams(filters).toString() : "";
    return getJSON<Stats>(`/api/stats${q}`);
  },
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
};
