// T015 — DB tests (written first). Migration, FK cascade, INSERT/SELECT, aggregations.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/store/db.js";
import { recordActivity, recordSubCall, getActivity } from "../src/store/activity.js";
import { kpis, costByModel, fusionsByDay, listActivity, totalCount } from "../src/store/stats.js";
import type { Database } from "better-sqlite3";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "of-db-"));
  db = openDatabase(join(dir, "test.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("db: schema", () => {
  it("creates activities + sub_calls tables", () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual(["activities", "schema_migrations", "sub_calls"]);
  });

  it("migration 002 adds generated_text + analysis_json columns and they round-trip", () => {
    const id = recordActivity(db, { candidate_count: 2, survivor_count: 2, status: "success" });
    recordSubCall(db, {
      activity_id: id,
      role: "worker",
      provider: "openai",
      model: "gpt-x",
      status: "ok",
      generated_text: "the worker's answer",
      analysis_json: null,
    });
    recordSubCall(db, {
      activity_id: id,
      role: "judge_analysis",
      provider: "anthropic",
      model: "claude-x",
      status: "ok",
      generated_text: null,
      analysis_json: JSON.stringify({ consensus: ["x"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [] }),
    });
    const got = getActivity(db, id)!;
    const worker = got.sub_calls.find((s) => s.role === "worker")!;
    const analysis = got.sub_calls.find((s) => s.role === "judge_analysis")!;
    expect(worker.generated_text).toBe("the worker's answer");
    expect(worker.analysis_json).toBeNull();
    expect(analysis.generated_text).toBeNull();
    expect(JSON.parse(analysis.analysis_json!)).toEqual({ consensus: ["x"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [] });
    // migration recorded
    const migs = db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[];
    expect(migs.map((m) => m.id)).toEqual(["001_initial", "002_add_generated_text", "003_add_persona", "004_add_persona_source"]);
  });

  it("enforces FK cascade: deleting an activity removes its sub_calls", () => {
    const id = recordActivity(db, { status: "success", candidate_count: 2, survivor_count: 2 });
    recordSubCall(db, { activity_id: id, role: "worker", provider: "openai", model: "gpt-x", status: "ok" });
    recordSubCall(db, { activity_id: id, role: "judge_analysis", provider: "anthropic", model: "claude-x", status: "ok" });
    db.prepare("DELETE FROM activities WHERE id = ?").run(id);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM sub_calls WHERE activity_id = ?").get(id) as { n: number };
    expect(remaining.n).toBe(0);
  });
});

describe("activity + sub_call logging", () => {
  it("records an activity and its N+2 sub_calls, then reads them back", () => {
    const id = recordActivity(db, {
      prompt_excerpt: "compare X vs Y",
      has_context: 1,
      candidate_count: 3,
      survivor_count: 3,
      judge_provider: "anthropic",
      judge_model: "claude-x",
      total_input_tokens: 100,
      total_output_tokens: 50,
      total_cost: 0.012,
      total_latency_ms: 5000,
      status: "success",
    });
    for (const role of ["worker", "worker", "worker", "judge_analysis", "judge_synthesis"]) {
      recordSubCall(db, {
        activity_id: id,
        role: role as "worker",
        provider: role.startsWith("judge") ? "anthropic" : "openai",
        model: role.startsWith("judge") ? "claude-x" : "gpt-x",
        input_tokens: 10,
        output_tokens: 5,
        cost: 0.001,
        latency_ms: 1000,
        status: "ok",
      });
    }
    const got = getActivity(db, id);
    expect(got).toBeDefined();
    expect(got!.candidate_count).toBe(3);
    expect(got!.sub_calls.length).toBe(5); // 3 workers + 2 judge steps
  });
});

describe("stats: aggregations", () => {
  beforeEach(() => {
    // Seed 3 fusions on two days across two models.
    const a1 = recordActivity(db, { candidate_count: 2, survivor_count: 2, judge_model: "claude-x", total_input_tokens: 100, total_output_tokens: 50, total_cost: 0.01, total_latency_ms: 1000, status: "success", created_at: "2026-06-15T10:00:00.000Z" });
    recordSubCall(db, { activity_id: a1, role: "worker", provider: "openai", model: "gpt-a", input_tokens: 50, output_tokens: 25, cost: 0.005, latency_ms: 500, status: "ok" });
    recordSubCall(db, { activity_id: a1, role: "worker", provider: "anthropic", model: "claude-a", input_tokens: 50, output_tokens: 25, cost: 0.005, latency_ms: 500, status: "ok" });
    recordSubCall(db, { activity_id: a1, role: "judge_analysis", provider: "anthropic", model: "claude-x", input_tokens: 0, output_tokens: 0, cost: 0, latency_ms: 0, status: "ok" });
    recordSubCall(db, { activity_id: a1, role: "judge_synthesis", provider: "anthropic", model: "claude-x", input_tokens: 0, output_tokens: 0, cost: 0, latency_ms: 0, status: "ok" });

    const a2 = recordActivity(db, { candidate_count: 2, survivor_count: 1, judge_model: "claude-x", total_input_tokens: 80, total_output_tokens: 40, total_cost: 0.02, total_latency_ms: 2000, status: "partial", created_at: "2026-06-16T10:00:00.000Z" });
    recordSubCall(db, { activity_id: a2, role: "worker", provider: "openai", model: "gpt-a", input_tokens: 40, output_tokens: 20, cost: 0.02, latency_ms: 1000, status: "ok" });

    const a3 = recordActivity(db, { candidate_count: 2, survivor_count: 0, judge_model: "claude-x", total_input_tokens: 0, total_output_tokens: 0, total_cost: 0, total_latency_ms: 500, status: "error", created_at: "2026-06-16T11:00:00.000Z" });
  });

  it("KPIs: count, cost, tokens, avg latency, success rate", () => {
    const k = kpis(db);
    expect(k.fusionCount).toBe(3);
    expect(k.totalCost).toBeCloseTo(0.03, 5);
    expect(k.totalTokens).toBe(270); // (100+50)+(80+40)+0
    expect(k.avgLatencyMs).toBeCloseTo((1000 + 2000 + 500) / 3, 1);
    expect(k.successRate).toBeCloseTo(1 / 3, 3);
  });

  it("costByModel groups sub_call cost per model", () => {
    const rows = costByModel(db);
    const map = Object.fromEntries(rows.map((r) => [r.model, r.cost]));
    expect(map["gpt-a"]).toBeCloseTo(0.005 + 0.02, 5);
    expect(map["claude-a"]).toBeCloseTo(0.005, 5);
  });

  it("fusionsByDay groups activities per day", () => {
    const rows = fusionsByDay(db);
    const map = Object.fromEntries(rows.map((r) => [r.day, r.count]));
    expect(map["2026-06-15"]).toBe(1); // a1
    expect(map["2026-06-16"]).toBe(2); // a2 + a3
  });

  it("listActivity paginates + totalCount", () => {
    expect(totalCount(db)).toBe(3);
    const page = listActivity(db, { limit: 2, offset: 0 });
    expect(page.length).toBe(2);
  });
});
