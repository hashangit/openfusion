// Dashboard aggregations over activities + sub_calls (activity as a dimension).
import type { DB } from "./db.js";
import type { ActivityRow } from "./activity.js";

export interface Filters {
  from?: string; // ISO date/datetime
  to?: string;
  model?: string;
  status?: string;
}

const activityWhere = (f: Filters): { clause: string; params: Record<string, unknown> } => {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (f.from) {
    clauses.push("created_at >= @from");
    params.from = f.from;
  }
  if (f.to) {
    clauses.push("created_at <= @to");
    params.to = f.to;
  }
  if (f.status) {
    clauses.push("status = @status");
    params.status = f.status;
  }
  return { clause: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
};

export function kpis(db: DB, filters: Filters = {}): {
  fusionCount: number;
  totalCost: number;
  totalTokens: number;
  avgLatencyMs: number;
  successRate: number;
} {
  const { clause, params } = activityWhere(filters);
  const row = db
    .prepare(
      `SELECT
         COUNT(*)                                              AS fusion_count,
         COALESCE(SUM(total_cost), 0)                          AS total_cost,
         COALESCE(SUM(total_input_tokens + total_output_tokens), 0) AS total_tokens,
         COALESCE(AVG(total_latency_ms), 0)                    AS avg_latency_ms,
         CASE WHEN COUNT(*) = 0 THEN 0
              ELSE 1.0 * SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) / COUNT(*)
         END                                                   AS success_rate
       FROM activities ${clause}`,
    )
    .get(params) as {
    fusion_count: number;
    total_cost: number;
    total_tokens: number;
    avg_latency_ms: number;
    success_rate: number;
  };
  return {
    fusionCount: row.fusion_count,
    totalCost: row.total_cost,
    totalTokens: row.total_tokens,
    avgLatencyMs: row.avg_latency_ms,
    successRate: row.success_rate,
  };
}

/**
 * Build the sub_calls↔activities join + WHERE for per-model aggregations.
 * Date range + status filter on the activity side; model filters on the sub_call side.
 */
function subCallModelWhere(f: Filters): { join: string; where: string; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (f.from) {
    clauses.push("a.created_at >= @from");
    params.from = f.from;
  }
  if (f.to) {
    clauses.push("a.created_at <= @to");
    params.to = f.to;
  }
  if (f.status) {
    clauses.push("a.status = @status");
    params.status = f.status;
  }
  if (f.model) {
    clauses.push("s.model = @model");
    params.model = f.model;
  }
  return {
    join: "JOIN activities a ON s.activity_id = a.id",
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

export function costByModel(
  db: DB,
  filters: Filters = {},
): { model: string; cost: number }[] {
  const { join, where, params } = subCallModelWhere(filters);
  return db
    .prepare(
      `SELECT s.model AS model, COALESCE(SUM(s.cost), 0) AS cost
       FROM sub_calls s ${join} ${where}
       GROUP BY s.model ORDER BY cost DESC`,
    )
    .all(params) as { model: string; cost: number }[];
}

/** Token usage (input + output) grouped by model — the new dashboard chart. */
export function tokensByModel(
  db: DB,
  filters: Filters = {},
): { model: string; tokens: number }[] {
  const { join, where, params } = subCallModelWhere(filters);
  return db
    .prepare(
      `SELECT s.model AS model,
              COALESCE(SUM(s.input_tokens + s.output_tokens), 0) AS tokens
       FROM sub_calls s ${join} ${where}
       GROUP BY s.model ORDER BY tokens DESC`,
    )
    .all(params) as { model: string; tokens: number }[];
}

export function fusionsByDay(
  db: DB,
  filters: Filters = {},
): { day: string; count: number }[] {
  const { clause, params } = activityWhere(filters);
  return db
    .prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS count
       FROM activities ${clause}
       GROUP BY day ORDER BY day ASC`,
    )
    .all(params) as { day: string; count: number }[];
}

export function listActivity(
  db: DB,
  opts: { limit: number; offset: number; filters?: Filters } = { limit: 25, offset: 0 },
): (ActivityRow & { id: string })[] {
  const f = opts.filters ?? {};
  const { clause, params } = activityWhere(f);
  return db
    .prepare(
      `SELECT * FROM activities ${clause} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: opts.limit, offset: opts.offset }) as (ActivityRow & {
    id: string;
  })[];
}

export function totalCount(db: DB, filters: Filters = {}): number {
  const { clause, params } = activityWhere(filters);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM activities ${clause}`).get(params) as { n: number };
  return row.n;
}
