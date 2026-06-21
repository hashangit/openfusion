// Candidate fan-out dispatch (feature 007).
//
// Extracted from fusion.ts so the orchestrator reads cleanly. Two execution modes
// (Constitution III — sequential is a user-opted alternative to the parallel default):
//   - runParallelFanout: the byte-for-byte original `Promise.all` behavior (INV-4).
//   - runSequentialFanout: candidates run one at a time in slot order, bounded by a
//     serial time budget that gates *launching* the next candidate (not aborting the
//     in-flight one — no AbortController; research R-002).
//
// Both take an already-built array of per-candidate runWorker inputs; the orchestrator
// owns deriving secrets/keys/persona prompt so this module stays scheduling-only.
import { runWorker, type WorkerInput, type WorkerResult } from "./worker.js";
import type { ProgressFn } from "./fusion.js";

/**
 * Serial time budget constants (research R-003). Conservative assumptions for a local
 * 7B–13B model under normal load. NOT user-tunable in v1 (YAGNI). Surfaced as helper
 * text near the Candidates toggle so the user sees the ceiling.
 *
 * NOTE (I4): these mirror the UI-side constants in ui/src/pages/Candidates.tsx
 * (PER_CANDIDATE_MIN = 3, JUDGE_STEPS_MIN = 6). TS constants don't trivially cross the
 * UI bundle boundary, so they're duplicated; serial-budget.test.ts asserts the two agree.
 * If either constant changes, update BOTH files + the test together.
 */
export const PER_CANDIDATE_MS = 180_000; // 3 min per candidate
export const JUDGE_STEPS_MS = 360_000; // 6 min total judging (3 analysis + 3 synthesis)

/** Total wall-clock budget for a sequential run, derived from candidate count. */
export function computeSerialBudgetMs(enabledCandidateCount: number): number {
  return PER_CANDIDATE_MS * enabledCandidateCount + JUDGE_STEPS_MS;
}

/**
 * Parallel fan-out — the original behavior, byte-for-byte (INV-4).
 * runWorker never throws (it catches internally → status ok/timeout/error), so
 * Promise.all is safe here (no short-circuit on rejection).
 *
 * `onUpdate` fires in *completion* order (not input order) as each worker resolves, with the
 * running count of resolved workers — this is what lets the Dashboard show "X of N responding"
 * rising during a parallel run (FR-013). The returned array stays in input/slot order; only
 * the side-effect callback observes completion order.
 */
export async function runParallelFanout(
  calls: WorkerInput[],
  opts: { onUpdate?: (candidatesDone: number) => void } = {},
): Promise<WorkerResult[]> {
  let done = 0;
  return Promise.all(
    calls.map((c) =>
      runWorker(c).then((r) => {
        done += 1;
        opts.onUpdate?.(done);
        return r;
      }),
    ),
  );
}

/**
 * Sequential fan-out — candidates one at a time in slot order (Phase 4 / US2 adds the
 * budget gate; Phase 3 / US1 ships ordering-only).
 *
 * `overrideBudgetMs` is a TEST-ONLY seam (U1): production callers MUST NOT pass it
 * (undefined → uses computeSerialBudgetMs(calls.length)). Tests inject a tiny budget to
 * exercise budget-exhaustion (T015).
 *
 * The budget gates *launching* the next candidate: before each runWorker call, if the
 * elapsed time since `startedAt` exceeds the budget, we stop and return the survivors
 * collected so far. The in-flight candidate is never aborted (no AbortController) — it
 * runs to its own per-worker timeout/retry resolution.
 *
 * `report` (best-effort progress) is called per candidate so a serial run shows which
 * candidate is currently running — distinct from parallel mode's single fan-out report.
 */
export async function runSequentialFanout(
  calls: WorkerInput[],
  opts: {
    overrideBudgetMs?: number;
    report?: ProgressFn;
    /** Per-candidate live-status update (1-indexed candidateIndex, running candidatesDone). */
    onUpdate?: (candidateIndex: number, candidatesDone: number) => void;
  } = {},
): Promise<WorkerResult[]> {
  const budgetMs = opts.overrideBudgetMs ?? computeSerialBudgetMs(calls.length);
  const startedAt = Date.now();
  const results: WorkerResult[] = [];
  const total = calls.length;
  for (let i = 0; i < calls.length; i++) {
    // Budget gate: stop *launching* further candidates when the run budget is exhausted.
    // (A candidate already in flight is not aborted — see header.)
    if (Date.now() - startedAt > budgetMs) break;

    const candidateIndex = i + 1; // 1-indexed for display ("candidate X of N running")
    opts.report?.(0, total, `candidate ${candidateIndex}/${total} running`);
    opts.onUpdate?.(candidateIndex, results.length); // running candidateIndex, done so far
    const result = await runWorker(calls[i]);
    results.push(result);
  }
  return results;
}
