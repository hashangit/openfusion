// Feature 008 — resume-store unit tests. Covers the fusion_jobs migration smoke test (T003)
// and the resume-store pure-DB surface (T004): kickoff/getJob lifecycle, markTerminal,
// markRetrieved, touchProgress, sweepInterrupted, sweepExpired. The bounded-long-poll
// awaitTerminal + in-memory waiters are exercised end-to-end in resume-parallel.test.ts
// (they need the full MCP round-trip); here we keep it to synchronous DB semantics.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/store/db.js";
import { recordActivity } from "../src/store/activity.js";
import {
  kickoffJob,
  getJob,
  markTerminal,
  markRetrieved,
  touchProgress,
  sweepInterrupted,
  sweepExpired,
  RESUME_TTL_MS,
  RESUME_STALL_MS,
  _clearWaitersForTests,
} from "../src/fusion/resume-store.js";
import type { DB } from "../src/store/db.js";

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "of-resume-"));
  db = openDatabase(join(dir, "test.db"));
});
afterEach(() => {
  _clearWaitersForTests();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Insert the parent activities row that the fusion_jobs FK references, then kickoff the
 * job. Mirrors production ordering: allocateActivity runs before kickoffJob (T013).
 */
function kickoffWithActivity(activityId: string, executionMode: "parallel" | "sequential" = "parallel"): void {
  recordActivity(db, { id: activityId, candidate_count: 2, survivor_count: 0, status: "running" });
  kickoffJob(db, { activityId, executionMode, etaMs: null });
}

describe("T003 — fusion_jobs migration", () => {
  it("creates the table with the expected columns + indexes (data-model.md)", () => {
    const cols = db
      .prepare("PRAGMA table_info(fusion_jobs)")
      .all() as { name: string; notnull: number; dflt_value: string | null }[];
    const names = cols.map((c) => c.name);
    // Every column from data-model.md §"Durable record" is present.
    expect(names).toEqual([
      "activity_id",
      "status",
      "execution_mode",
      "result",
      "result_is_error",
      "error_kind",
      "created_at",
      "completed_at",
      "expires_at",
      "last_progress_at",
      "stall_threshold_ms",
      "eta_ms",
      "retrieved_at",
    ]);
    // result_is_error defaults to 0 (FR-014: distinguishes error-vs-answer).
    const rie = cols.find((c) => c.name === "result_is_error")!;
    expect(rie.dflt_value).toBe("0");
    expect(rie.notnull).toBe(1);
    // stall_threshold_ms defaults to RESUME_STILL_MS (300000) — scrutinize fix.
    const st = cols.find((c) => c.name === "stall_threshold_ms")!;
    expect(st.dflt_value).toBe("300000");
    expect(st.notnull).toBe(1);
    // status / execution_mode / created_at / expires_at are NOT NULL (always set at kickoff).
    for (const required of ["status", "execution_mode", "created_at", "expires_at"]) {
      expect(cols.find((c) => c.name === required)!.notnull).toBe(1);
    }

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='fusion_jobs' AND name NOT LIKE 'sqlite_autoindex_%'")
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name).sort()).toEqual([
      "idx_fusion_jobs_completed",
      "idx_fusion_jobs_expires",
      "idx_fusion_jobs_status",
    ]);
  });

  it("is idempotent — reopening a DB that already has the table is a no-op", () => {
    db.close();
    db = openDatabase(join(dir, "test.db"));
    // Table still queryable; re-running migrations did not duplicate columns.
    const cols = (db.prepare("PRAGMA table_info(fusion_jobs)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toHaveLength(13);
  });
});

describe("T004 — resume-store lifecycle", () => {
  it("kickoffJob inserts a processing row with expires_at = created_at + TTL; eta_ms null for parallel (F7)", () => {
    kickoffWithActivity("a1");
    const job = getJob(db, "a1")!;
    expect(job.status).toBe("processing");
    expect(job.execution_mode).toBe("parallel");
    expect(job.result).toBeNull();
    expect(job.result_is_error).toBe(0);
    expect(job.error_kind).toBeNull();
    expect(job.completed_at).toBeNull();
    expect(job.eta_ms).toBeNull(); // F7
    expect(job.retrieved_at).toBeNull();
    expect(job.last_progress_at).not.toBeNull(); // set at kickoff
    const delta = Date.parse(job.expires_at) - Date.parse(job.created_at);
    expect(delta).toBe(RESUME_TTL_MS);
  });

  it("markTerminal(ok) transitions to completed with the answer; result_is_error=0", () => {
    kickoffWithActivity("a2");
    markTerminal(db, "a2", { ok: true, result: "the synthesized answer" });
    const job = getJob(db, "a2")!;
    expect(job.status).toBe("completed");
    expect(job.result).toBe("the synthesized answer");
    expect(job.result_is_error).toBe(0);
    expect(job.error_kind).toBeNull();
    expect(job.completed_at).not.toBeNull();
  });

  it("markTerminal(!ok) records error_kind structurally (FR-014): judge-failed vs no-survivors", () => {
    kickoffWithActivity("a3");
    markTerminal(db, "a3", { ok: false, result: "judge threw", errorKind: "judge-failed" });
    const judge = getJob(db, "a3")!;
    expect(judge.status).toBe("error");
    expect(judge.result_is_error).toBe(1);
    expect(judge.error_kind).toBe("judge-failed");

    kickoffWithActivity("a4");
    markTerminal(db, "a4", { ok: false, result: "only 1 survivor", errorKind: "no-survivors" });
    const surv = getJob(db, "a4")!;
    expect(surv.error_kind).toBe("no-survivors");
  });

  it("markTerminal defaults unknown failures to 'internal' error_kind", () => {
    kickoffWithActivity("a5");
    markTerminal(db, "a5", { ok: false, result: "boom" });
    expect(getJob(db, "a5")!.error_kind).toBe("internal");
  });

  it("markTerminal is a no-op after sweepInterrupted reclassified the row (n13 optimistic guard)", () => {
    kickoffWithActivity("a6");
    // Simulate a startup sweep firing before the surviving runner writes terminal.
    const n = sweepInterrupted(db, new Date(Date.now() + 60_000).toISOString());
    expect(n).toBe(1);
    expect(getJob(db, "a6")!.status).toBe("interrupted");
    // Late runner write must NOT overwrite the sweep's interrupted (n13).
    markTerminal(db, "a6", { ok: true, result: "too late" });
    const job = getJob(db, "a6")!;
    expect(job.status).toBe("interrupted"); // sweep won
    expect(job.result).toBeNull(); // the late write was dropped
  });

  it("scrutinize pass 3: a completed markTerminal OVERWRITES a speculative stalled reclassification (but NOT interrupted/expired)", () => {
    // The stall circuit is speculative — it fires when progress callbacks are late, which can
    // happen under event-loop blocking even if the runner is genuinely still working. If the
    // runner then completes for real, its answer should win over the stall guess.
    kickoffWithActivity("a-stall-override");
    // Simulate the stall circuit firing on a retrieval read.
    db.prepare("UPDATE fusion_jobs SET status='error', error_kind='stalled', result='guess: stalled' WHERE activity_id = ?").run("a-stall-override");
    expect(getJob(db, "a-stall-override")!.status).toBe("error");

    // The runner completes for real.
    markTerminal(db, "a-stall-override", { ok: true, result: "the real answer" });
    const job = getJob(db, "a-stall-override")!;
    expect(job.status).toBe("completed"); // completed overrode stalled
    expect(job.result).toBe("the real answer");
    expect(job.error_kind).toBeNull();

    // BUT: a non-completed write (error) does NOT override stalled (no resurrection of worse state).
    kickoffWithActivity("a-stall-no-override");
    db.prepare("UPDATE fusion_jobs SET status='error', error_kind='stalled', result='guess: stalled' WHERE activity_id = ?").run("a-stall-no-override");
    markTerminal(db, "a-stall-no-override", { ok: false, result: "different error", errorKind: "no-survivors" });
    const job2 = getJob(db, "a-stall-no-override")!;
    expect(job2.status).toBe("error"); // still error
    expect(job2.error_kind).toBe("stalled"); // the first reclassification won — not overwritten by a later error
  });

  it("markTerminal write-late guard (FR-011): a processing row near expiry gets expires_at extended before storing", () => {
    kickoffWithActivity("a7");
    // Force the row to the edge of eviction.
    const edge = new Date(Date.now() + 1_000).toISOString();
    db.prepare("UPDATE fusion_jobs SET expires_at = ? WHERE activity_id = ?").run(edge, "a7");
    // A late completion should land as completed, not expired — the guard extended expires_at.
    markTerminal(db, "a7", { ok: true, result: "late but stored" });
    const job = getJob(db, "a7")!;
    expect(job.status).toBe("completed");
    expect(job.result).toBe("late but stored");
    // expires_at was pushed back out beyond the edge.
    expect(Date.parse(job.expires_at)).toBeGreaterThan(Date.now());
  });

  it("markRetrieved is idempotent — only the first terminal retrieval sets retrieved_at (F3)", () => {
    kickoffWithActivity("a8");
    markTerminal(db, "a8", { ok: true, result: "done" });
    markRetrieved(db, "a8");
    const first = getJob(db, "a8")!.retrieved_at;
    expect(first).not.toBeNull();
    // A second call must not overwrite (idempotent WHERE retrieved_at IS NULL).
    markRetrieved(db, "a8");
    expect(getJob(db, "a8")!.retrieved_at).toBe(first);
  });

  it("touchProgress refreshes last_progress_at on processing rows; no-op on terminal", () => {
    kickoffWithActivity("a9");
    // Force a deliberately stale last_progress_at so a refresh is unambiguous.
    const stale = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE fusion_jobs SET last_progress_at = ? WHERE activity_id = ?").run(stale, "a9");
    const before = Date.now();
    touchProgress(db, "a9");
    const after = Date.parse(getJob(db, "a9")!.last_progress_at!);
    // The refreshed timestamp is at or after the call (not the stale baseline).
    expect(after).toBeGreaterThanOrEqual(before);

    // On a terminal row, touchProgress is a silent no-op (WHERE status='processing').
    markTerminal(db, "a9", { ok: true, result: "x" });
    const terminal = getJob(db, "a9")!.last_progress_at;
    touchProgress(db, "a9");
    expect(getJob(db, "a9")!.last_progress_at).toBe(terminal);
  });
});

describe("T004 — sweeps", () => {
  it("sweepInterrupted reclassifies processing rows created before bootTime (R-007)", () => {
    kickoffWithActivity("b1");
    kickoffWithActivity("b2");
    const bootTime = new Date(Date.now() + 60_000).toISOString(); // after both created_at
    const n = sweepInterrupted(db, bootTime);
    expect(n).toBe(2);
    expect(getJob(db, "b1")!.status).toBe("interrupted");
    expect(getJob(db, "b2")!.status).toBe("interrupted");
  });

  it("sweepInterrupted is safe to call when bootTime precedes created_at (no-op, multi-process safe)", () => {
    // R-007 multi-process reality: another process's in-flight fusion must NOT be swept.
    kickoffWithActivity("b3");
    const bootTime = new Date(Date.now() - 60_000).toISOString(); // before created_at
    const n = sweepInterrupted(db, bootTime);
    expect(n).toBe(0);
    expect(getJob(db, "b3")!.status).toBe("processing");
  });

  it("sweepExpired reclassifies terminal rows past expires_at, leaves processing alone (write-late guard)", () => {
    kickoffWithActivity("b4");
    markTerminal(db, "b4", { ok: true, result: "done" });
    // Push the completed row past expiry.
    db.prepare("UPDATE fusion_jobs SET expires_at = ? WHERE activity_id = ?").run(
      new Date(Date.now() - 1_000).toISOString(),
      "b4",
    );
    // A processing row past expiry must NOT be expired by the sweep — the write-late guard.
    kickoffWithActivity("b5");
    db.prepare("UPDATE fusion_jobs SET expires_at = ? WHERE activity_id = ?").run(
      new Date(Date.now() - 1_000).toISOString(),
      "b5",
    );

    const n = sweepExpired(db);
    expect(n).toBe(1);
    expect(getJob(db, "b4")!.status).toBe("expired");
    // b5 stays processing — only terminal rows age out via sweep.
    expect(getJob(db, "b5")!.status).toBe("processing");
  });
});

describe("T004 — stalled circuit (FR-012)", () => {
  it("getJob reclassifies a processing row with stale last_progress_at to error/stalled", () => {
    kickoffWithActivity("c1");
    // Age last_progress_at beyond the stall threshold.
    db.prepare("UPDATE fusion_jobs SET last_progress_at = ? WHERE activity_id = ?").run(
      new Date(Date.now() - (RESUME_STALL_MS + 1_000)).toISOString(),
      "c1",
    );
    const job = getJob(db, "c1")!;
    expect(job.status).toBe("error");
    expect(job.error_kind).toBe("stalled");
    expect(job.result_is_error).toBe(1);
    // Reclassification wrote through, so a second read is consistent.
    expect(getJob(db, "c1")!.status).toBe("error");
  });

  it("scrutinize fix: a SEQUENTIAL job with stale progress > RESUME_STALL_MS but < stall_threshold_ms stays processing", () => {
    // Regression for the sequential-stall blocker: runSequentialFanout reports progress
    // per-candidate, not mid-candidate, so a single candidate running 3–9 min has NO
    // touchProgress during the run. The per-row stall_threshold_ms (computed from
    // workerTimeoutMs × 3 at kickoff) must accommodate this gap.
    recordActivity(db, { id: "seq-1", candidate_count: 2, survivor_count: 0, status: "running" });
    // workerTimeoutMs=5min → stall_threshold = max(5min, 5min×3) = 15min.
    kickoffJob(db, { activityId: "seq-1", executionMode: "sequential", etaMs: 12 * 60_000, stallThresholdMs: 15 * 60_000 });
    // Age last_progress_at past the bare RESUME_STALL_MS (5min) but under the per-row threshold (15min).
    db.prepare("UPDATE fusion_jobs SET last_progress_at = ? WHERE activity_id = ?").run(
      new Date(Date.now() - (RESUME_STALL_MS + 60_000)).toISOString(), // 6min stale
      "seq-1",
    );
    const job = getJob(db, "seq-1")!;
    expect(job.status).toBe("processing"); // NOT stalled — under the per-row threshold
    expect(job.error_kind).toBeNull();
  });

  it("scrutinize fix: a job with progress stale BEYOND stall_threshold_ms IS reclassified as stalled", () => {
    // The per-row threshold is a floor, not a license to hang forever. A job whose progress
    // is stale past its threshold is genuinely stalled.
    recordActivity(db, { id: "seq-2", candidate_count: 2, survivor_count: 0, status: "running" });
    kickoffJob(db, { activityId: "seq-2", executionMode: "sequential", etaMs: 5 * 60_000, stallThresholdMs: 5 * 60_000 });
    db.prepare("UPDATE fusion_jobs SET last_progress_at = ? WHERE activity_id = ?").run(
      new Date(Date.now() - (6 * 60_000)).toISOString(), // 6min stale > 5min threshold
      "seq-2",
    );
    const job = getJob(db, "seq-2")!;
    expect(job.status).toBe("error");
    expect(job.error_kind).toBe("stalled");
  });

  it("scrutinize fix: a PARALLEL job with high workerTimeoutMs uses the per-row threshold, not the bare 5min", () => {
    // The parallel false-positive: workerTimeoutMs=10min → a worker exhausting 3 retries
    // produces a ~30min progress gap. The bare 5min threshold would false-positive; the
    // per-row threshold (max(5min, 10min×3) = 30min) accommodates it.
    recordActivity(db, { id: "par-1", candidate_count: 2, survivor_count: 0, status: "running" });
    kickoffJob(db, { activityId: "par-1", executionMode: "parallel", etaMs: null, stallThresholdMs: 30 * 60_000 });
    // 10min stale — past the bare 5min, under the per-row 30min.
    db.prepare("UPDATE fusion_jobs SET last_progress_at = ? WHERE activity_id = ?").run(
      new Date(Date.now() - (10 * 60_000)).toISOString(),
      "par-1",
    );
    expect(getJob(db, "par-1")!.status).toBe("processing");
  });
});

describe("T004 — getJob not-found", () => {
  it("returns undefined for an unknown id (retrieval path maps this to not_found)", () => {
    expect(getJob(db, "never-existed")).toBeUndefined();
  });
});
