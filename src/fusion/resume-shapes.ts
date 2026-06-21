// Feature 008 — mode-aware `_resume_from` result shapes (contracts/resume-from.md).
//
// Pure functions over a FusionJob + config snapshot that build the {content, _meta} pair
// returned by the fusion tool for the deferred-result path. Two cadences (research R-004):
//   - Parallel (~60-140s): tight bounded long-poll + terse transparent-pacing wording.
//   - Sequential (~12-21min): ETA-guided fire-and-forget + user-facing long-job wording
//     with a dashboard link.
//
// Both modes carry `retry_after_ms` (R-005 B2 BLOCKER) so the agent doesn't tight-loop, in
// BOTH the prose instruction AND the structured `_meta` block (m10) — text for humans/loose
// parsers, `_meta` for reliable structured extraction.
//
// M4: wording is transparent pacing — a "call this to get the result" mandate + an explicit
// retry_after_ms. There is NO "do not inform the user" directive anywhere (the earlier
// adversarial framing risks tripping safety-training refusals in frontier models, which
// would kill the retrieval outright). See research R-004.
//
// These are PURE (no I/O) — trivially unit-testable. The MCP layer calls them; the shapes
// never touch the DB or the runner.
import type { FusionJob, ExecutionMode } from "./resume-store.js";

/** The MCP CallToolResult content + meta pair these builders return. */
export interface ResumeShape {
  content: { type: "text"; text: string }[];
  /** m10: structured reference id + pacing signal for reliable agent parsing. */
  _meta?: { reference_id: string; retry_after_ms: number };
}

/**
 * Parallel-mode retry_after_ms: sized just under RESUME_LONG_POLL_MS (~40s) — if the agent
 * waits ~30s before re-calling, the long-poll window typically catches completion. Exported
 * so tests can assert the exact pacing.
 */
export const PARALLEL_RETRY_AFTER_MS = 30_000;

/**
 * Sequential-mode dashboard URL (contracts/resume-from.md). Same origin as the UI server
 * (127.0.0.1:9077 per Constitution IV); the activity query param selects the live-status
 * view for this fusion.
 */
export const DASHBOARD_BASE = "http://127.0.0.1:9077";

function dashboardUrl(activityId: string): string {
  return `${DASHBOARD_BASE}/?activity=${activityId}`;
}

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

// --- Kickoff shapes (non-Tasks client, _resume_from absent) -----------------

/**
 * Parallel kickoff (FR-001, FR-005). Terse transparent-pacing wording + retrieval mandate
 * + retry_after_ms. No ETA (F7 — the wait is short enough that tight-poll is the right
 * cadence; an ETA would invite the agent to sleep instead of retrieving).
 */
export function parallelKickoff(activityId: string, retryAfterMs: number = PARALLEL_RETRY_AFTER_MS): ResumeShape {
  const text =
    `Fusion started in the background (reference_id: ${activityId}). It takes roughly 60-140 seconds.\n` +
    `Call fusion({ "_resume_from": "${activityId}" }) to receive the result — retry after approximately ${seconds(retryAfterMs)} seconds if it is not ready yet.`;
  return {
    content: [{ type: "text", text }],
    _meta: { reference_id: activityId, retry_after_ms: retryAfterMs },
  };
}

/**
 * Sequential kickoff (FR-005). User-facing long-job wording: honest ETA derived from
 * computeSerialBudgetMs (spec 007), the dashboard URL for live progress, and a retry_after_ms
 * = max(eta/4, 60s) so the agent paces itself toward completion rather than tight-polling.
 */
export function sequentialKickoff(
  activityId: string,
  etaMs: number,
  retryAfterMs: number = Math.max(Math.round(etaMs / 4), 60_000),
): ResumeShape {
  const etaMin = Math.max(1, Math.round(etaMs / 60_000));
  const text =
    `Fusion started in the background (reference_id: ${activityId}). This is a sequential run and will take approximately ${etaMin} minutes.\n` +
    `Live progress: ${dashboardUrl(activityId)}\n` +
    `Call fusion({ "_resume_from": "${activityId}" }) later to retrieve the answer, or tell the user to watch the dashboard. Retry after approximately ${seconds(retryAfterMs)} seconds if it is not ready yet.`;
  return {
    content: [{ type: "text", text }],
    _meta: { reference_id: activityId, retry_after_ms: retryAfterMs },
  };
}

// --- Retrieval shapes (_resume_from present) --------------------------------

/**
 * Parallel processing: the bounded long-poll returned without a terminal transition.
 * Transparent-pacing wording + the same retry_after_ms as kickoff.
 */
export function parallelProcessing(
  activityId: string,
  retryAfterMs: number = PARALLEL_RETRY_AFTER_MS,
): ResumeShape {
  const text =
    `Fusion ${activityId} is still running. Call fusion({ "_resume_from": "${activityId}" }) again to receive the result — retry after approximately ${seconds(retryAfterMs)} seconds if it is not ready yet.`;
  return {
    content: [{ type: "text", text }],
    _meta: { reference_id: activityId, retry_after_ms: retryAfterMs },
  };
}

/**
 * Sequential processing (FR-005): immediate return (no long-poll — ETA-guided). Refined
 * remaining ETA from (eta_ms - elapsed) + the dashboard link.
 */
export function sequentialProcessing(
  activityId: string,
  remainingMs: number,
  retryAfterMs: number = Math.max(Math.round(remainingMs / 4), 60_000),
): ResumeShape {
  const remainingMin = Math.max(1, Math.round(remainingMs / 60_000));
  const text =
    `Fusion ${activityId} is still running (approximately ${remainingMin} minutes remaining).\n` +
    `Live progress: ${dashboardUrl(activityId)}\n` +
    `Call fusion({ "_resume_from": "${activityId}" }) later, or tell the user to watch the dashboard.`;
  return {
    content: [{ type: "text", text }],
    _meta: { reference_id: activityId, retry_after_ms: retryAfterMs },
  };
}

/**
 * Completed (FR-015 / SC-006): the synthesized answer ALONE, byte-identical to what the
 * legacy blocking path / the Tasks path would return for the same inputs. No wrapper, no
 * metadata — so the agent treats it exactly like any other fusion result.
 *
 * NOTE: this deliberately returns NO `_meta`. The completed shape is the answer text; adding
 * reference_id/retry_after_ms here would be noise the agent has no use for (the job is done).
 */
export function completed(answer: string): ResumeShape {
  return { content: [{ type: "text", text: answer }] };
}

/**
 * Error — judge-failed (FR-014). Distinct from a generic fusion error so the user can tell
 * their candidates were good (the judge broke, not the consensus). Raw candidate access is
 * via the activity's sub_calls — NOT inlined here (would bloat the agent's context).
 */
export function errorJudgeFailed(activityId: string, message: string): ResumeShape {
  const text =
    `Fusion ${activityId} completed its candidates but the judge failed: ${message}.\n` +
    `Candidate responses are available; re-run fusion with your original query to retry, or check the dashboard.`;
  return { content: [{ type: "text", text }] };
}

/** Error — other (no-survivors / stalled / internal). */
export function errorGeneric(activityId: string, message: string): ResumeShape {
  const text =
    `Fusion ${activityId} did not complete successfully: ${message}.\n` +
    `Re-run fusion with your original query, or check the dashboard.`;
  return { content: [{ type: "text", text }] };
}

/** Interrupted by a server restart (FR-009, R-007). */
export function interrupted(activityId: string): ResumeShape {
  const text =
    `Fusion ${activityId} was interrupted by a server restart and did not finish.\n` +
    `Re-run fusion with your original query, or check the dashboard.`;
  return { content: [{ type: "text", text }] };
}

/** Expired past TTL (FR-008). */
export function expired(activityId: string): ResumeShape {
  const text =
    `Fusion ${activityId} has expired (its result was not retrieved in time).\n` +
    `Re-run fusion with your original query.`;
  return { content: [{ type: "text", text }] };
}

/** Unknown reference id (FR-003). */
export function notFound(id: string): ResumeShape {
  const text =
    `No fusion found for reference_id "${id}". It may be unknown, already expired, or from a previous session.\n` +
    `Re-run fusion with your original query.`;
  return { content: [{ type: "text", text }] };
}

// --- Dispatch helper --------------------------------------------------------

/**
 * Map a FusionJob's status to its retrieval shape (the single retrieval site's shape
 * selector). `answer`/`message` come from the job's result column (set by markTerminal).
 *
 * Sequential-mode processing is ETA-guided (no long-poll); the caller computes remainingMs
 * from eta_ms - elapsed before calling this, OR calls sequentialProcessing directly. This
 * helper handles the status→shape mapping that's identical across modes (completed/error/
 * interrupted/expired) and the parallel processing shape; the sequential processing shape
 * is built by the caller (it needs the remaining-ETA calculation).
 */
export function shapeForRetrieval(
  job: FusionJob | undefined,
  id: string,
  opts: { executionMode: ExecutionMode; remainingMs?: number; retryAfterMs?: number } = { executionMode: "parallel" },
): ResumeShape {
  if (!job) return notFound(id);

  switch (job.status) {
    case "completed":
      return completed(job.result ?? "");
    case "error":
      if (job.error_kind === "judge-failed") {
        return errorJudgeFailed(id, job.result ?? "judge failed");
      }
      return errorGeneric(id, job.result ?? "fusion failed");
    case "interrupted":
      return interrupted(id);
    case "expired":
      return expired(id);
    case "processing":
      // Sequential retrieval is ETA-guided (immediate, no long-poll). The caller must pass
      // remainingMs derived from eta_ms - elapsed; without it we fall back to the parallel
      // shape (defensive — should not happen if the dispatch reads eta_ms correctly).
      if (opts.executionMode === "sequential" && opts.remainingMs !== undefined) {
        return sequentialProcessing(id, opts.remainingMs, opts.retryAfterMs);
      }
      return parallelProcessing(id, opts.retryAfterMs);
  }
}
