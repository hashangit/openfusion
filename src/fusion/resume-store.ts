// Feature 008 — durable FusionJob store for the `_resume_from` deferred-result path.
//
// One row per deferred fusion in the `fusion_jobs` table (migration 005_fusion_jobs),
// keyed by the activity id (= the reference id, INV-2). Durable from kickoff (INV-3);
// live candidate-progress stays ephemeral (FR-010) and is NOT consulted here.
//
// Two concerns live in this module:
//   (a) the durable CRUD + status state machine (kickoff/get/markTerminal/markRetrieved/
//       touchProgress/sweepInterrupted/sweepExpired) over the SQLite table;
//   (b) the bounded-long-poll waiter for parallel-mode retrieval (an in-memory
//       Map<activityId, resolver[]> that resolves on terminal or timeout — research R-005).
//
// Pure DB + Promise logic; NO fusion imports (the runner calls markTerminal/touchProgress,
// the MCP retrieval path calls awaitTerminal/getJob). The single retrieval site (INV-1).
//
// stdout is the JSON-RPC channel — ALL logs go to stderr (AGENTS.md conventions).
import type { DB } from "../store/db.js";

/**
 * Bounded long-poll wait for a parallel-mode retrieval (research R-005). Sized under the
 * ~60s codex per-call ceiling (R-001, VERIFIED) with margin, AND tall enough that a ~90s
 * fusion returns in ≤3 LLM round-trips (SC-002): kickoff + poll(45s, times out) + poll(completes)
 * = 3 calls for a 90s fusion. If R-001 ever surfaces a tighter client ceiling, only this
 * constant moves (and SC-002's budget moves with it).
 */
export const RESUME_LONG_POLL_MS = 45_000;

/**
 * Post-completion retention TTL (research R-006). Bounds how long a completed answer stays
 * retrievable after the fact. NOTE: the write-late guard (markTerminal) extends expires_at
 * while status='processing', so job *length* is uncapped (F10) — a 21-min sequential job
 * that completes at minute 20 still stores its result; this TTL only governs how long that
 * result lingers after completion. Generous for sequential/benchmark jobs.
 */
export const RESUME_TTL_MS = 1_800_000; // 30 min

/**
 * Stalled-circuit threshold (research R-006, FR-012). A processing row whose
 * last_progress_at is older than this is reclassified to error/stalled on read, so a hung
 * fusion can't empty long-poll forever. Worst-case stall detection ≈ workerTimeoutMs ×
 * (retries+1) ≈ ~6min, comfortably under 2× this — see research R-006 heartbeat story.
 */
export const RESUME_STALL_MS = 300_000; // 5 min

/** Durable statuses for a fusion_jobs row (data-model.md state machine). */
export type FusionJobStatus =
  | "processing"
  | "completed"
  | "interrupted"
  | "expired"
  | "error";

/** Distinguishable failure kinds (FR-014; FusionResult.errorKind maps to this). */
export type FusionJobErrorKind = "no-survivors" | "judge-failed" | "stalled" | "internal";

/** Execution mode snapshot stored at kickoff (drives the retrieval shape — R-004). */
export type ExecutionMode = "parallel" | "sequential";

/** The durable record (mirrors the fusion_jobs row). */
export interface FusionJob {
  activity_id: string;
  status: FusionJobStatus;
  execution_mode: ExecutionMode;
  result: string | null;
  result_is_error: number; // 0 | 1
  error_kind: FusionJobErrorKind | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string;
  last_progress_at: string | null;
  stall_threshold_ms: number; // scrutinize fix — per-row threshold accounts for workerTimeoutMs × retries
  eta_ms: number | null;
  retrieved_at: string | null;
}

/** True for statuses that will never change again (completed/error/interrupted/expired). */
function isTerminal(status: FusionJobStatus): boolean {
  return status !== "processing";
}

// --- (a) Durable CRUD + state machine -------------------------------------

/**
 * Insert a processing row at kickoff (INV-3). Called BEFORE startDetachedFusion dispatches
 * (m12 — write ordering: the fusion_jobs kickoff row goes in first; taskStore.createTask is
 * a sibling write for the Tasks path and is non-fatal if it drops).
 *
 * `etaMs` is null for parallel mode (F7 — the parallel kickoff message omits ETA by design);
 * sequential mode passes computeSerialBudgetMs(N).
 *
 * `stallThresholdMs` (scrutinize fix): the per-row stalled-circuit threshold, computed by the
 * caller from `workerTimeoutMs × (attempts+1)` so a legitimate inter-callback gap (one worker
 * exhausting all retries) doesn't false-positive. Defaults to RESUME_STALL_MS if omitted.
 */
export function kickoffJob(
  db: DB,
  opts: { activityId: string; executionMode: ExecutionMode; etaMs: number | null; stallThresholdMs?: number },
): void {
  const now = new Date().toISOString();
  const stall = opts.stallThresholdMs ?? RESUME_STALL_MS;
  db.prepare(`
    INSERT INTO fusion_jobs
      (activity_id, status, execution_mode, created_at, expires_at, last_progress_at, stall_threshold_ms, eta_ms)
    VALUES (?, 'processing', ?, ?, ?, ?, ?, ?)
  `).run(opts.activityId, opts.executionMode, now, new Date(Date.now() + RESUME_TTL_MS).toISOString(), now, stall, opts.etaMs);
}

type DbRow = {
  activity_id: string;
  status: FusionJobStatus;
  execution_mode: ExecutionMode;
  result: string | null;
  result_is_error: number;
  error_kind: FusionJobErrorKind | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string;
  last_progress_at: string | null;
  stall_threshold_ms: number;
  eta_ms: number | null;
  retrieved_at: string | null;
};

/**
 * Read a job, applying lazy reclassification on read:
 *   - processing past stall_threshold_ms → error/stalled (FR-012 stalled circuit)
 *   - terminal past expires_at           → expired (FR-008 TTL eviction)
 *
 * STALL THRESHOLD IS PER-ROW (scrutinize fix): each row carries its own `stall_threshold_ms`,
 * computed at kickoff from `workerTimeoutMs × (attempts+1)`. This correctly handles BOTH modes:
 *   - Parallel: a worker exhausting all 3 retries against a slow endpoint can legitimately
 *     produce a progress gap of ~3×workerTimeoutMs; the threshold accounts for that.
 *   - Sequential: a single candidate runs 3–9 min with NO mid-candidate progress callback
 *     (runSequentialFanout reports per-candidate); the threshold (≥ workerTimeoutMs × 3) covers it.
 * The earlier mode-aware `max(RESUME_STALL_MS, eta_ms)` approach was incomplete because eta_ms
 * is optimistic (doesn't account for retries) and parallel mode had no eta to scale against.
 *
 * The reclassification writes through to the row so subsequent reads are consistent and so
 * the never-retrieved counter (sweepExpired) sees the right terminal status.
 *
 * Returns undefined when no row exists (the retrieval path maps that to not_found).
 */
export function getJob(db: DB, activityId: string): FusionJob | undefined {
  const row = db.prepare("SELECT * FROM fusion_jobs WHERE activity_id = ?").get(activityId) as
    | DbRow
    | undefined;
  if (!row) return undefined;

  const now = Date.now();

  // Stalled circuit: a processing row with no recent progress is reclassified to error/stalled.
  // last_progress_at is set at kickoff INSERT, so a job that hangs immediately is still caught.
  // The threshold is per-row (see header) — accounts for the legitimate inter-callback gap.
  const stallThresholdMs = row.stall_threshold_ms ?? RESUME_STALL_MS;
  if (row.status === "processing" && row.last_progress_at && now - Date.parse(row.last_progress_at) > stallThresholdMs) {
    reclassify(db, activityId, {
      status: "error",
      error_kind: "stalled",
      result: `Fusion ${activityId} stalled: no progress for more than ${Math.round(stallThresholdMs / 60_000)} minutes.`,
      result_is_error: 1,
    });
    resolveWaiters(activityId);
    // Re-read so the returned object reflects the write-through (result_is_error, result, etc.).
    return getJob(db, activityId);
  }

  // TTL eviction: a terminal row past its expires_at is reclassified to expired.
  if (isTerminal(row.status) && row.status !== "expired" && now > Date.parse(row.expires_at)) {
    reclassify(db, activityId, { status: "expired" });
    return { ...row, status: "expired" };
  }

  return row;
}

/** Patch the status (and optional terminal fields) of a row; no-op if the row is gone. */
function reclassify(
  db: DB,
  activityId: string,
  patch: Partial<Pick<FusionJob, "status" | "error_kind" | "result" | "result_is_error">> & { status: FusionJobStatus },
): void {
  const sets: string[] = ["status = @status"];
  const params: Record<string, unknown> = { activity_id: activityId, status: patch.status };
  if (patch.error_kind !== undefined) {
    sets.push("error_kind = @error_kind");
    params.error_kind = patch.error_kind;
  }
  if (patch.result !== undefined) {
    sets.push("result = @result");
    params.result = patch.result;
  }
  if (patch.result_is_error !== undefined) {
    sets.push("result_is_error = @result_is_error");
    params.result_is_error = patch.result_is_error;
  }
  db.prepare(`UPDATE fusion_jobs SET ${sets.join(", ")} WHERE activity_id = @activity_id`).run(params);
}

/**
 * Store the terminal result of a fusion (called by startDetachedFusion's terminal handler,
 * T013). Resolves all in-memory waiters for the id. Defends two races:
 *
 *   - Write-late guard (R-006 option b, FR-011): a processing row whose expires_at is near
 *     gets its expires_at EXTENDED before the terminal write, so a late completion never
 *     lands as expired. Job length is uncapped (F10).
 *   - Optimistic terminal guard (n13): the UPDATE is gated on `status='processing'` so a
 *     startup-sweep-reclassified `interrupted` row can't be overwritten by a surviving
 *     runner's late `completed` write. `changes === 0` is logged, not fatal.
 *
 * `errorKind` flows from FusionResult.errorKind (T013a) so FR-014's judge-failed vs
 * no-survivors distinction is structural, not string-parsed.
 */
export function markTerminal(
  db: DB,
  activityId: string,
  terminal: { ok: boolean; result: string; errorKind?: FusionJobErrorKind },
): void {
  const now = new Date().toISOString();
  const status: FusionJobStatus = terminal.ok ? "completed" : "error";
  const result_is_error = terminal.ok ? 0 : 1;
  const error_kind = terminal.ok ? null : (terminal.errorKind ?? "internal");

  // Write-late guard: extend expires_at for processing rows so a late completion isn't
  // evicted by a concurrent TTL read. (Completed/error rows age out normally.)
  db.prepare(`
    UPDATE fusion_jobs
      SET expires_at = ?
      WHERE activity_id = ? AND status = 'processing'
  `).run(new Date(Date.now() + RESUME_TTL_MS).toISOString(), activityId);

  const info = db
    .prepare(`
      UPDATE fusion_jobs
        SET status = ?, result = ?, result_is_error = ?, error_kind = ?, completed_at = ?
        WHERE activity_id = ? AND (status = 'processing' OR (status = 'error' AND error_kind = 'stalled' AND ? = 'completed'))
    `)
    .run(status, terminal.result, result_is_error, error_kind, now, activityId, status);

  if (info.changes === 0) {
    // n13: the row was already reclassified (interrupted by startup sweep, or expired by a
    // concurrent read). A surviving runner's late terminal write must NOT overwrite those.
    // EXCEPTION (scrutinize pass 3): a `completed` write DOES override a speculative `stalled`
    // reclassification — if the runner genuinely finished, its answer is real and more
    // informative than the stall guess (which fired only because progress callbacks were late,
    // e.g. under event-loop blocking). `interrupted`/`expired` are never overridden (those are
    // authoritative terminal states, not speculative).
    console.error(
      `[resume-store] markTerminal no-op for ${activityId}: row is no longer 'processing' ` +
        `(sweep/expired won; or a non-completed write against stalled). Dropping ${status} write.`,
    );
  }

  // Resolve any in-memory long-poll waiters regardless — a retrieval in flight when the
  // runner writes terminal should still wake up (it will re-read the row and see the
  // sweep's status if the optimistic guard fired).
  resolveWaiters(activityId);
}

/**
 * Record the first terminal retrieval (F3 never-retrieved counter). Idempotent — only the
 * FIRST terminal retrieval sets retrieved_at; subsequent retrievals leave it untouched.
 * Drives the never-retrieved observability signal in sweepExpired.
 */
export function markRetrieved(db: DB, activityId: string): void {
  db.prepare(`
    UPDATE fusion_jobs SET retrieved_at = ?
      WHERE activity_id = ? AND retrieved_at IS NULL
  `).run(new Date().toISOString(), activityId);
}

/**
 * Refresh last_progress_at (called by the runner's onProgress — T013). Keeps the stalled
 * circuit from firing during healthy runs. Best-effort: a missing row (swept/expired) is
 * a silent no-op (the runner may still fire progress after sweep; harmless).
 */
export function touchProgress(db: DB, activityId: string): void {
  db.prepare(`
    UPDATE fusion_jobs SET last_progress_at = ?
      WHERE activity_id = ? AND status = 'processing'
  `).run(new Date().toISOString(), activityId);
}

/**
 * Startup sweep (R-007, FR-009). At boot, mark every `processing` row whose created_at
 * precedes `bootTime` as `interrupted` — these are orphans from a previous process (the
 * detached runner died with the process). The condition is correct as written: bootTime is
 * `now` and created_at is a past timestamp for every pre-existing row, so the sweep catches
 * ALL orphaned processing rows regardless of how recently they were created.
 *
 * MUST run as a blocking init step BEFORE the MCP transport accepts connections (B3), or a
 * post-restart retrieval can race a stale `processing` row and long-poll a dead job.
 */
export function sweepInterrupted(db: DB, bootTime: string): number {
  const info = db
    .prepare(`
      UPDATE fusion_jobs SET status = 'interrupted'
        WHERE status = 'processing' AND created_at < ?
    `)
    .run(bootTime);
  return info.changes;
}

/**
 * TTL eviction sweep (FR-008). Reclassifies terminal rows past their expires_at to expired.
 * Logs the never-retrieved counter (F3) whenever a `completed` row ages out with
 * retrieved_at IS NULL — the observability signal for abandoned compute (Constitution V)
 * and the leading indicator that codex has shipped native Tasks support (the counter drops
 * to ~0 when clients stop using `_resume_from`).
 */
export function sweepExpired(db: DB): number {
  const now = new Date().toISOString();

  // F3: count never-retrieved completed rows about to expire, BEFORE reclassifying them.
  const neverRetrieved = db
    .prepare(`
      SELECT COUNT(*) AS n FROM fusion_jobs
        WHERE status = 'completed' AND retrieved_at IS NULL AND expires_at < ?
    `)
    .get(now) as { n: number };
  if (neverRetrieved.n > 0) {
    // stderr (AGENTS.md); a metric, not a user-facing warning. Constitution V: no silent ops.
    console.error(
      `[resume-store] never-retrieved counter: ${neverRetrieved.n} completed fusion(s) aged out without ever being retrieved (compute burned for nothing).`,
    );
  }

  const info = db
    .prepare(`
      UPDATE fusion_jobs SET status = 'expired'
        WHERE status IN ('completed', 'error', 'interrupted') AND expires_at < ?
    `)
    .run(now);
  return info.changes;
}

// --- (b) Bounded long-poll waiter (parallel mode) -------------------------

/**
 * Per-activityId resolvers waiting on a terminal transition. In-memory only — dies with
 * the process (which is fine: a retrieval after restart hits a terminal/interrupted row
 * and never waits). The durable row is the source of truth; this map only collapses polls.
 *
 * The resolver takes the (re-read) job only to satisfy the historical signature; in
 * practice the caller re-reads via getJob on wake (so post-wake sweeps/reclassifications
 * are reflected). resolveWaiters invokes them with undefined; awaitTerminal ignores the arg.
 */
const waiters = new Map<string, Array<() => void>>();

function resolveWaiters(activityId: string): void {
  const list = waiters.get(activityId);
  if (!list || list.length === 0) return;
  waiters.delete(activityId);
  for (const resolve of list) resolve();
}

/**
 * Bounded long-poll: if the job is already terminal, mark retrieved and return immediately
 * (the completed fast-path — SC-003). Otherwise register a waiter, race against
 * `setTimeout(waitMs)`, and return the (re-read) job on resolve-or-timeout. The caller maps
 * the job to a shape; a processing job after timeout yields the parallel processing shape.
 *
 * Single retrieval site (INV-1): both the immediate-terminal and the wait paths go through
 * getJob, so the stalled circuit + TTL eviction apply uniformly.
 *
 * NOTE: sequential mode does NOT call this — it returns processing immediately (ETA-guided,
 * FR-005). Only parallel retrieval bounded-long-polls.
 */
export async function awaitTerminal(
  db: DB,
  activityId: string,
  waitMs: number = RESUME_LONG_POLL_MS,
): Promise<FusionJob | undefined> {
  const immediate = getJob(db, activityId);
  if (!immediate) return undefined;
  if (isTerminal(immediate.status)) {
    markRetrieved(db, activityId);
    return immediate;
  }

  // Register a waiter. The resolver is purposefully untyped about WHICH job fired it — the
  // caller re-reads via getJob on wake so the latest status (post-sweep/stall/reclassify)
  // is what's returned, not a stale snapshot captured at resolve time.
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Best-effort removal from the waiters list; resolveWaiters may have already cleared it.
      // NOTE: search for `finish` (the function pushed at list.push(finish) below), NOT `resolve`
      // (the promise resolver) — they are different function objects. Searching for the wrong
      // one leaves stale closures in the list (scrutinize fix).
      const list = waiters.get(activityId);
      if (list) {
        const i = list.indexOf(finish);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) waiters.delete(activityId);
      }
      resolve();
    };
    const list = waiters.get(activityId) ?? [];
    // finish() is what markTerminal/resolveWaiters will invoke; push it as the waiter.
    list.push(finish);
    waiters.set(activityId, list);
    const timer = setTimeout(finish, waitMs);
  });

  const after = getJob(db, activityId);
  if (after && isTerminal(after.status)) {
    markRetrieved(db, activityId);
  }
  return after;
}

/**
 * Test-only: clear the in-memory waiters map (used by the durability suite to simulate a
 * process restart without reopening the DB). Production never calls this.
 */
export function _clearWaitersForTests(): void {
  waiters.clear();
}
