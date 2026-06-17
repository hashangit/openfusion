// Activity + sub_call logging. One activity row per fusion, N+2 sub_call rows.
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";

export interface ActivityRow {
  id?: string;
  created_at?: string;
  prompt_excerpt?: string;
  has_context?: number;
  candidate_count: number;
  survivor_count: number;
  judge_provider?: string;
  judge_model?: string;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cost?: number;
  total_latency_ms?: number;
  status: string;
  error?: string | null;
  /** Persona id/name used for this fusion (migration 003; null for pre-0.2.1 fusions). */
  persona?: string | null;
}

export interface SubCallRow {
  id?: string;
  activity_id: string;
  created_at?: string;
  role: "worker" | "judge_analysis" | "judge_synthesis";
  slot_id?: string | null;
  provider: string;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
  latency_ms?: number;
  status: "ok" | "timeout" | "error";
  error?: string | null;
  /** The generated text (worker output / judge synthesized answer). null for failures or judge_analysis. */
  generated_text?: string | null;
  /** Structured analysis (judge_analysis only), JSON-stringified. */
  analysis_json?: string | null;
}

export interface ActivityWithSubCalls extends ActivityRow {
  id: string;
  sub_calls: (SubCallRow & { id: string })[];
}

const insertActivity = (db: DB) =>
  db.prepare(`
    INSERT INTO activities
      (id, created_at, prompt_excerpt, has_context, candidate_count, survivor_count,
       judge_provider, judge_model, total_input_tokens, total_output_tokens,
       total_cost, total_latency_ms, status, error, persona)
    VALUES (@id, @created_at, @prompt_excerpt, @has_context, @candidate_count, @survivor_count,
       @judge_provider, @judge_model, @total_input_tokens, @total_output_tokens,
       @total_cost, @total_latency_ms, @status, @error, @persona)
  `);

export function recordActivity(db: DB, row: ActivityRow): string {
  const id = row.id ?? randomUUID();
  insertActivity(db).run({
    id,
    created_at: row.created_at ?? new Date().toISOString(),
    prompt_excerpt: row.prompt_excerpt ?? null,
    has_context: row.has_context ?? 0,
    candidate_count: row.candidate_count,
    survivor_count: row.survivor_count,
    judge_provider: row.judge_provider ?? null,
    judge_model: row.judge_model ?? null,
    total_input_tokens: row.total_input_tokens ?? 0,
    total_output_tokens: row.total_output_tokens ?? 0,
    total_cost: row.total_cost ?? 0,
    total_latency_ms: row.total_latency_ms ?? 0,
    status: row.status,
    error: row.error ?? null,
    persona: row.persona ?? null,
  });
  return id;
}

const insertSubCall = (db: DB) =>
  db.prepare(`
    INSERT INTO sub_calls
      (id, activity_id, created_at, role, slot_id, provider, model,
       input_tokens, output_tokens, cost, latency_ms, status, error,
       generated_text, analysis_json)
    VALUES (@id, @activity_id, @created_at, @role, @slot_id, @provider, @model,
       @input_tokens, @output_tokens, @cost, @latency_ms, @status, @error,
       @generated_text, @analysis_json)
  `);

export function recordSubCall(db: DB, row: SubCallRow): string {
  const id = row.id ?? randomUUID();
  insertSubCall(db).run({
    id,
    activity_id: row.activity_id,
    created_at: row.created_at ?? new Date().toISOString(),
    role: row.role,
    slot_id: row.slot_id ?? null,
    provider: row.provider,
    model: row.model,
    input_tokens: row.input_tokens ?? 0,
    output_tokens: row.output_tokens ?? 0,
    cost: row.cost ?? 0,
    latency_ms: row.latency_ms ?? 0,
    status: row.status,
    error: row.error ?? null,
    generated_text: row.generated_text ?? null,
    analysis_json: row.analysis_json ?? null,
  });
  return id;
}

/** Update aggregate/status fields on an existing activity row (used when finalizing a fusion). */
export function updateActivity(db: DB, id: string, patch: Partial<ActivityRow>): void {
  const allowed: (keyof ActivityRow)[] = [
    "survivor_count",
    "total_input_tokens",
    "total_output_tokens",
    "total_cost",
    "total_latency_ms",
    "status",
    "error",
  ];
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const key of allowed) {
    if (key in patch) {
      sets.push(`${key} = @${key}`);
      params[key] = patch[key] as unknown;
    }
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE activities SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

export function getActivity(db: DB, id: string): ActivityWithSubCalls | undefined {
  const activity = db.prepare("SELECT * FROM activities WHERE id = ?").get(id) as
    | (ActivityRow & { id: string })
    | undefined;
  if (!activity) return undefined;
  const sub_calls = db
    .prepare("SELECT * FROM sub_calls WHERE activity_id = ? ORDER BY created_at ASC")
    .all(id) as (SubCallRow & { id: string })[];
  return { ...activity, sub_calls };
}
