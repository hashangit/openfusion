// Feature 005 — MCP Tasks (SEP-1686): the detached fusion runner.
//
// When a task-augmented `fusion` call arrives, `startDetachedFusion` allocates an activity
// row up front (status='running'), records the taskId→activityId correlation, then
// fire-and-forgets `runFusion` on the event loop. On completion/failure it stores the
// final CallToolResult in the TaskStore and cleans up the correlation map. The work runs
// in the same Node process (Constitution VII — Simple & Local); no worker threads.
//
// stdout is the JSON-RPC channel — ALL logs go to stderr (AGENTS.md conventions).
import { runFusion, PROMPT_EXCERPT_LEN, type FusionResult } from "./fusion.js";
import type { PersonaEvent, PersonaEventResult } from "./persona-policy.js";
import { allocateActivity } from "../store/activity.js";
import { loadConfig } from "../config/store.js";
import { kickoffJob, markTerminal, touchProgress, type ExecutionMode } from "./resume-store.js";
import type { DB } from "../store/db.js";
import type { RequestTaskStore } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Task } from "@modelcontextprotocol/sdk/types.js";

/**
 * Minimal view of the MCP handler `extra` we need: the taskStore injected by the SDK
 * when a task-augmented request arrives. The SDK injects a `RequestTaskStore` (createTask
 * curried to 1 arg). Kept structural so we don't couple to the full experimental extra type.
 */
export interface TaskHandlerExtra {
  taskStore: RequestTaskStore;
}

/**
 * Minimal view of `CreateTaskResult.task` returned by `taskStore.createTask`.
 * We return the full Task object so the SDK's createTask handler type-checks.
 */
type CreatedTask = Task;

/** Args for the detached runner, mirroring the fusion tool input + per-call deps. */
export interface DetachedFusionArgs {
  prompt: string;
  context?: string;
  persona?: string;
  db: DB;
  openBrowserOnNeedsConfig?: boolean;
  /**
   * Optional persona-event callback (feature 006). The MCP createTask handler builds this
   * from its `extra` (notification + elicitation) and forwards it so the detached fusion
   * enforces persona policy identically to the blocking path (FR-009 — single enforcement
   * site in runFusion, both entry paths wired).
   */
  onPersonaEvent?: (e: PersonaEvent) => Promise<PersonaEventResult>;
}

/**
 * Feature 008: the kickoff-time inputs the runner needs to write the fusion_jobs row.
 * Passed in separately from DetachedFusionArgs because the kickoff site (mcp-server.ts)
 * computes executionMode/etaMs from the config snapshot BEFORE dispatching — the runner
 * itself re-loads config (runFusion snapshots at fusion start, F5) but the *kickoff* row
 * must reflect the mode the caller intended.
 */
export interface KickoffContext {
  executionMode: ExecutionMode;
  /** Parallel: null (F7). Sequential: computeSerialBudgetMs(N) from spec 007. */
  etaMs: number | null;
  /**
   * Per-row stalled-circuit threshold (scrutinize fix). Computed by the caller from
   * `workerTimeoutMs × (attempts+1)` so a legitimate inter-callback gap (one worker exhausting
   * all 3 retries) doesn't false-positive. When omitted, kickoffJob defaults to RESUME_STALL_MS.
   */
  stallThresholdMs?: number;
}

/**
 * taskId → activityId correlation. taskId is store-generated (32-char hex) and cannot be
 * forced to equal the activityId, so we keep a map (research.md R-003). Bounded by
 * in-flight fusions (single process, low cardinality); entries are deleted on terminal.
 */
const taskActivity = new Map<string, string>();

/**
 * Allocate an activity row, create the task, and kick off the detached fusion.
 * Called from the `createTask` handler (Tasks path) OR from resume-dispatch's kickoff
 * branch (non-Tasks `_resume_from` path — `extra` omitted, no taskStore).
 *
 * The returned promise resolves as soon as the kickoff row + task are created (sub-second);
 * the fusion itself runs detached and updates both stores on completion/failure.
 *
 * Feature 008 (T013): the fusion_jobs durable row is written FIRST (m12 — before
 * taskStore.createTask), so the `_resume_from` path can retrieve the job even if the
 * taskStore write later drops (the `_resume_from` path is canonical; the Tasks path falls
 * back to SDK blocking if the store write fails — research R-008). The kickoff context
 * (executionMode + etaMs) is computed by the caller from the config snapshot.
 *
 * @param extra The Tasks handler extra. When OMITTED (the non-Tasks `_resume_from` kickoff
 *   path), the taskStore substrate is skipped entirely — no createTask/storeTaskResult calls,
 *   no taskActivity map entry. The fusion_jobs row is the sole durable record on that path.
 */
export async function startDetachedFusion(
  args: DetachedFusionArgs,
  extra: TaskHandlerExtra | undefined,
  kickoff?: KickoffContext,
): Promise<{ task: CreatedTask | undefined; activityId: string }> {
  const candidateCount = countCandidates();
  const activityId = allocateActivity(args.db, {
    candidate_count: candidateCount,
    survivor_count: 0,
    prompt_excerpt: excerpt(args.prompt),
    has_context: args.context ? 1 : 0,
  });

  // m12: write the fusion_jobs kickoff row FIRST. It is the canonical durable record for the
  // `_resume_from` retrieval path (INV-3). executionMode defaults to parallel when the caller
  // omits the kickoff context (legacy 005-era callers that don't need the row for retrieval).
  // MUST follow allocateActivity above — fusion_jobs.activity_id has a FOREIGN KEY referencing
  // activities(id); inserting the child before the parent is an FK violation (scrutinize fix).
  const mode = kickoff?.executionMode ?? "parallel";
  kickoffJob(args.db, {
    activityId,
    executionMode: mode,
    etaMs: kickoff?.etaMs ?? null,
    stallThresholdMs: kickoff?.stallThresholdMs,
  });

  // Tasks path only: create the task in the store (mints the taskId + Task object). The
  // non-Tasks `_resume_from` path skips this entirely — fusion_jobs is its sole substrate.
  let task: CreatedTask | undefined;
  if (extra) {
    try {
      task = await extra.taskStore.createTask({ ttl: TASK_TTL_MS });
      taskActivity.set(task.taskId, activityId);
    } catch (storeErr: unknown) {
      console.error(`[task-runner] taskStore.createTask failed for ${activityId} (continuing — _resume_from path is canonical):`, storeErr);
      throw storeErr; // The Tasks path genuinely needs the task; re-throw so createTask surfaces it.
    }
  }

  // Fire-and-forget, but tracked so tests/teardown can drain (drainTasks) and so the
  // outer catch still transitions the task to a terminal state if runDetached throws
  // BEFORE its inner try block (e.g. during setup).
  const taskId = task?.taskId;
  const p = runDetached(args, taskId, activityId, extra?.taskStore)
    .catch(async (err: unknown) => {
      console.error(`[task-runner] detached fusion ${activityId} threw before terminal:`, err);
      // Best-effort: force the task to 'failed' so it can never hang in 'working' (Tasks path).
      if (taskId && extra?.taskStore) {
        try {
          await extra.taskStore.storeTaskResult(
            taskId,
            "failed",
            { isError: true, content: [{ type: "text", text: `Internal error: ${errorMessage(err)}` }] },
          );
        } catch (storeErr: unknown) {
          console.error(`[task-runner] failed to store error result for ${taskId}:`, storeErr);
        }
      }
      // Also mark the fusion_jobs row terminal so the _resume_from path sees the failure
      // (T013 — shared substrate; both egress paths get the terminal write).
      try {
        markTerminal(args.db, activityId, {
          ok: false,
          result: errorMessage(err),
          errorKind: "internal",
        });
      } catch (markErr: unknown) {
        console.error(`[task-runner] markTerminal (outer catch) failed for ${activityId}:`, markErr);
      }
    })
    .finally(() => {
      activeTasks.delete(p);
      if (taskId) taskActivity.delete(taskId);
    });
  activeTasks.add(p);
  void p;
  return { task, activityId };
}

/**
 * In-flight detached fusions, for deterministic test teardown and a future SIGTERM drain.
 * Added per OpenFusion consultation finding #2 — avoids the test teardown race cleanly
 * (await this before closing the DB) without polling.
 */
const activeTasks = new Set<Promise<void>>();

/** Resolve once all in-flight detached fusions have settled (terminal or rejected). */
export async function drainTasks(): Promise<void> {
  await Promise.allSettled([...activeTasks]);
}

const TASK_TTL_MS = 10 * 60_000; // 10 min — well above any realistic fusion duration.

/** The detached body: run fusion, forward progress, store terminal result, clean up. */
async function runDetached(
  args: DetachedFusionArgs,
  taskId: string | undefined,
  activityId: string,
  taskStore: RequestTaskStore | undefined,
): Promise<void> {
  const taskReport = taskId && taskStore ? makeTaskProgressReporter(taskId, taskStore) : undefined;
  // T013: every progress callback also touches fusion_jobs.last_progress_at so the stalled
  // circuit (FR-012) doesn't fire during healthy runs. Wrapped to never throw into the fusion
  // path (Constitution III) — a DB write failure here is logged, not propagated.
  const report = (progress: number, total: number, message: string) => {
    taskReport?.(progress, total, message);
    try {
      touchProgress(args.db, activityId);
    } catch (err: unknown) {
      console.error(`[task-runner] touchProgress failed for ${activityId}:`, err);
    }
  };
  let result: FusionResult;
  try {
    result = await runFusion({
      prompt: args.prompt,
      context: args.context,
      persona: args.persona,
      config: loadConfig(),
      db: args.db,
      activityId,
      onProgress: report,
      onPersonaEvent: args.onPersonaEvent,
    });
  } catch (err) {
    // runFusion never throws in practice (it returns FusionResult with ok:false), but
    // defend against an unexpected throw so the task can't hang in `working`.
    console.error(`[task-runner] runFusion threw for ${activityId}:`, err);
    result = { ok: false, error: errorMessage(err), status: "error", errorKind: "internal" };
  }
  // NOTE: taskActivity cleanup is owned by the outer finally in startDetachedFusion,
  // so it also runs if we throw before reaching here (consultation finding #2).

  // T013: write the fusion_jobs terminal state (canonical for the `_resume_from` path;
  // shared substrate for the Tasks path — research R-008). The synthesized answer text is
  // identical in both egress paths — FR-015.
  try {
    markTerminal(args.db, activityId, {
      ok: result.ok,
      result: result.ok ? (result.answer ?? "") : (result.error ?? "Fusion failed."),
      errorKind: result.errorKind,
    });
  } catch (err: unknown) {
    // Non-fatal: the taskStore write below still serves the Tasks path. The `_resume_from`
    // retrieval will see a stale `processing` row (and eventually the stalled circuit fires).
    console.error(`[task-runner] markTerminal failed for ${activityId}:`, err);
  }

  // Tasks path only: store the terminal CallToolResult for tasks/result retrieval.
  if (taskId && taskStore) {
    if (result.ok) {
      await taskStore.storeTaskResult(taskId, "completed", {
        content: [{ type: "text", text: result.answer ?? "" }],
      });
    } else {
      await taskStore.storeTaskResult(taskId, "failed", {
        isError: true,
        content: [{ type: "text", text: result.error ?? "Fusion failed." }],
      });
    }
  }
}

/** Resolve the activityId for a taskId (used by getTask/getTaskResult enrichment, if needed). */
export function activityIdForTask(taskId: string): string | undefined {
  return taskActivity.get(taskId);
}

// --- helpers ---

function countCandidates(): number {
  // Candidate count is only needed for the activity row's metadata; the actual fan-out
  // (runFusion) re-resolves the enabled candidates itself.
  try {
    const cfg = loadConfig();
    return (cfg.candidates ?? []).filter((c) => c.enabled !== false).length;
  } catch {
    return 0;
  }
}

function excerpt(s: string): string {
  return s.length > PROMPT_EXCERPT_LEN ? `${s.slice(0, PROMPT_EXCERPT_LEN)}…` : s;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Build a progress callback that updates the task's statusMessage (best-effort).
 * `tasks/get` then surfaces the stage. Never throws into the fusion path (Constitution III).
 */
function makeTaskProgressReporter(
  taskId: string,
  taskStore: RequestTaskStore,
): (progress: number, total: number, message: string) => void {
  return (_progress, _total, message) => {
    // Fire-and-forget; progress is advisory and must not break fusion.
    void taskStore
      .updateTaskStatus(taskId, "working", message)
      .catch((err: unknown) => console.error(`[task-runner] progress update failed for ${taskId}:`, err));
  };
}
