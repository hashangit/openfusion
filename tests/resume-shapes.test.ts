// Feature 008 — resume-shapes unit tests (T005). Pure-function assertions over the exact
// wording in contracts/resume-from.md — these lock the agent-facing contract. The MCP
// retrieval-path integration (kickoff/retrieval wiring these shapes to the tool handler) is
// covered by resume-parallel.test.ts (T006-T009); here we keep it to the shape builders.
import { describe, it, expect } from "vitest";
import {
  parallelKickoff,
  sequentialKickoff,
  parallelProcessing,
  sequentialProcessing,
  completed,
  errorJudgeFailed,
  errorGeneric,
  interrupted,
  expired,
  notFound,
  shapeForRetrieval,
  PARALLEL_RETRY_AFTER_MS,
  DASHBOARD_BASE,
} from "../src/fusion/resume-shapes.js";
import type { FusionJob } from "../src/fusion/resume-store.js";

/** Shorthand builder for a FusionJob with just the fields shapeForRetrieval reads. */
function job(partial: Partial<FusionJob> & Pick<FusionJob, "activity_id" | "status">): FusionJob {
  return {
    execution_mode: "parallel",
    result: null,
    result_is_error: 0,
    error_kind: null,
    created_at: "2026-06-19T00:00:00.000Z",
    completed_at: null,
    expires_at: "2026-06-19T00:30:00.000Z",
    last_progress_at: null,
    eta_ms: null,
    retrieved_at: null,
    ...partial,
  };
}

describe("T005 — kickoff shapes", () => {
  it("parallelKickoff: reference_id + retrieval mandate + retry_after_ms in prose AND _meta; NO 'do not inform' (M4)", () => {
    const { content, _meta } = parallelKickoff("act-123");
    const text = content[0].text;
    expect(text).toContain("reference_id: act-123");
    expect(text).toContain('Call fusion({ "_resume_from": "act-123" })');
    expect(text).toMatch(/retry after approximately 30 seconds/i);
    // M4: the adversarial directive MUST NOT appear anywhere.
    expect(text).not.toMatch(/do not inform/i);
    // _meta carries the same values for structured parsing (m10).
    expect(_meta).toEqual({ reference_id: "act-123", retry_after_ms: PARALLEL_RETRY_AFTER_MS });
    // F7: parallel kickoff omits ETA — an ETA would invite sleeping instead of retrieving.
    expect(text).not.toMatch(/eta|minutes/i);
  });

  it("sequentialKickoff: ETA + dashboard URL + user-facing wording; retry_after_ms = max(eta/4, 60s)", () => {
    const etaMs = 15 * 60_000; // 15 min
    const { content, _meta } = sequentialKickoff("act-456", etaMs);
    const text = content[0].text;
    expect(text).toContain("reference_id: act-456");
    expect(text).toMatch(/approximately 15 minutes/i);
    expect(text).toContain(`${DASHBOARD_BASE}/?activity=act-456`);
    // retry_after_ms = max(eta/4, 60s) = max(3.75min, 1min) ≈ 225s → "approximately 225 seconds" (rounded).
    expect(_meta?.retry_after_ms).toBe(Math.max(Math.round(etaMs / 4), 60_000));
    // Sequential wording is user-facing ("tell the user to watch the dashboard") — NOT the terse parallel shape.
    expect(text).toMatch(/tell the user to watch the dashboard/i);
    expect(text).not.toMatch(/do not inform/i);
  });

  it("sequentialKickoff floors retry_after_ms at 60s for very short ETAs", () => {
    const { _meta } = sequentialKickoff("a", 30_000); // 30s ETA → eta/4 = 7.5s → floored to 60s
    expect(_meta?.retry_after_ms).toBe(60_000);
  });
});

describe("T005 — retrieval shapes", () => {
  it("parallelProcessing: still-running wording + retry mandate + retry_after_ms", () => {
    const { content, _meta } = parallelProcessing("act-7");
    expect(content[0].text).toContain("act-7 is still running");
    expect(content[0].text).toContain('Call fusion({ "_resume_from": "act-7" }) again');
    expect(_meta?.reference_id).toBe("act-7");
    expect(_meta?.retry_after_ms).toBe(PARALLEL_RETRY_AFTER_MS);
  });

  it("sequentialProcessing: remaining ETA + dashboard link + no tight-poll mandate", () => {
    const { content } = sequentialProcessing("act-8", 10 * 60_000);
    const text = content[0].text;
    expect(text).toMatch(/approximately 10 minutes remaining/i);
    expect(text).toContain(`${DASHBOARD_BASE}/?activity=act-8`);
    // ETA-guided: NO "call again" mandate (unlike parallel). The user watches the dashboard.
    expect(text).not.toMatch(/call fusion.*again/i);
  });

  it("completed: the answer ALONE, byte-identical to the blocking path (SC-006); no _meta", () => {
    const shape = completed("the synthesized answer");
    expect(shape.content[0].text).toBe("the synthesized answer");
    expect(shape.content).toHaveLength(1);
    expect(shape._meta).toBeUndefined(); // no noise on a completed result
  });

  it("errorJudgeFailed: distinct from generic error (FR-014); mentions candidate availability", () => {
    const text = errorJudgeFailed("act-9", "synthesis timed out").content[0].text;
    expect(text).toContain("completed its candidates but the judge failed");
    expect(text).toContain("Candidate responses are available");
  });

  it("errorGeneric: the standard fusion-failure wording (no-survivors / stalled / internal)", () => {
    const text = errorGeneric("act-10", "only 1 of 3 candidates succeeded").content[0].text;
    expect(text).toContain("did not complete successfully");
    expect(text).not.toMatch(/judge failed/i); // distinct from errorJudgeFailed
  });

  it("interrupted: restart wording + re-run instruction", () => {
    const text = interrupted("act-11").content[0].text;
    expect(text).toMatch(/interrupted by a server restart/i);
    expect(text).toMatch(/re-run fusion/i);
  });

  it("expired: TTL wording + re-run instruction", () => {
    const text = expired("act-12").content[0].text;
    expect(text).toMatch(/expired/i);
    expect(text).toMatch(/re-run fusion/i);
  });

  it("notFound: unknown-id wording", () => {
    const text = notFound("never-existed").content[0].text;
    expect(text).toContain('reference_id "never-existed"');
    expect(text).toMatch(/re-run fusion/i);
  });
});

describe("T005 — shapeForRetrieval dispatch", () => {
  it("undefined job → notFound", () => {
    const text = shapeForRetrieval(undefined, "missing").content[0].text;
    expect(text).toContain('reference_id "missing"');
  });

  it("completed → completed shape (answer alone)", () => {
    const j = job({ activity_id: "a", status: "completed", result: "the answer" });
    expect(shapeForRetrieval(j, "a").content[0].text).toBe("the answer");
  });

  it("error + judge-failed → errorJudgeFailed (distinct wording)", () => {
    const j = job({ activity_id: "a", status: "error", error_kind: "judge-failed", result: "boom", result_is_error: 1 });
    expect(shapeForRetrieval(j, "a").content[0].text).toContain("judge failed");
  });

  it("error + no-survivors → errorGeneric", () => {
    const j = job({ activity_id: "a", status: "error", error_kind: "no-survivors", result: "only 1 survivor", result_is_error: 1 });
    expect(shapeForRetrieval(j, "a").content[0].text).toContain("did not complete successfully");
  });

  it("processing (parallel) → parallelProcessing", () => {
    const j = job({ activity_id: "a", status: "processing" });
    expect(shapeForRetrieval(j, "a").content[0].text).toContain("still running");
  });

  it("processing (sequential) + remainingMs → sequentialProcessing", () => {
    const j = job({ activity_id: "a", status: "processing", execution_mode: "sequential", eta_ms: 15 * 60_000 });
    const text = shapeForRetrieval(j, "a", { executionMode: "sequential", remainingMs: 10 * 60_000 }).content[0].text;
    expect(text).toMatch(/approximately 10 minutes remaining/i);
  });

  it("interrupted / expired → their respective shapes", () => {
    const ij = job({ activity_id: "a", status: "interrupted" });
    expect(shapeForRetrieval(ij, "a").content[0].text).toMatch(/interrupted/i);
    const ej = job({ activity_id: "a", status: "expired" });
    expect(shapeForRetrieval(ej, "a").content[0].text).toMatch(/expired/i);
  });
});
