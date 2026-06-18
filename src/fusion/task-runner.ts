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
import { allocateActivity } from "../store/activity.js";
import { loadConfig } from "../config/store.js";
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
}

/**
 * taskId → activityId correlation. taskId is store-generated (32-char hex) and cannot be
 * forced to equal the activityId, so we keep a map (research.md R-003). Bounded by
 * in-flight fusions (single process, low cardinality); entries are deleted on terminal.
 */
const taskActivity = new Map<string, string>();

/**
 * Allocate an activity row, create the task, and kick off the detached fusion.
 * Called from the `createTask` handler. Returns the created task for the CreateTaskResult.
 *
 * The returned promise resolves as soon as the task is created (sub-second); the fusion
 * itself runs detached and updates the task store on completion/failure.
 */
export async function startDetachedFusion(
  args: DetachedFusionArgs,
  extra: TaskHandlerExtra,
): Promise<CreatedTask> {
  const candidateCount = countCandidates();
  const activityId = allocateActivity(args.db, {
    candidate_count: candidateCount,
    survivor_count: 0,
    prompt_excerpt: excerpt(args.prompt),
    has_context: args.context ? 1 : 0,
  });

  // Create the task in the store; this mints the taskId + full Task object.
  const task = await extra.taskStore.createTask({ ttl: TASK_TTL_MS });
  taskActivity.set(task.taskId, activityId);

  // Fire-and-forget, but tracked so tests/teardown can drain (drainTasks) and so the
  // outer catch still transitions the task to a terminal state if runDetached throws
  // BEFORE its inner try block (e.g. during setup). Without this outer storeTaskResult,
  // such a throw would maroon the task in 'working' until TTL expiry (FR-009 violation).
  const p = runDetached(args, task.taskId, activityId, extra.taskStore)
    .catch(async (err: unknown) => {
      console.error(`[task-runner] detached fusion ${task.taskId} threw before terminal:`, err);
      // Best-effort: force the task to 'failed' so it can never hang in 'working'.
      try {
        await extra.taskStore.storeTaskResult(
          task.taskId,
          "failed",
          { isError: true, content: [{ type: "text", text: `Internal error: ${errorMessage(err)}` }] },
        );
      } catch (storeErr: unknown) {
        console.error(`[task-runner] failed to store error result for ${task.taskId}:`, storeErr);
      }
    })
    .finally(() => {
      activeTasks.delete(p);
      taskActivity.delete(task.taskId);
    });
  activeTasks.add(p);
  void p;
  return task;
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
  taskId: string,
  activityId: string,
  taskStore: RequestTaskStore,
): Promise<void> {
  const report = makeTaskProgressReporter(taskId, taskStore);
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
    });
  } catch (err) {
    // runFusion never throws in practice (it returns FusionResult with ok:false), but
    // defend against an unexpected throw so the task can't hang in `working`.
    console.error(`[task-runner] runFusion threw for task ${taskId}:`, err);
    result = { ok: false, error: errorMessage(err), status: "error" };
  }
  // NOTE: taskActivity cleanup is owned by the outer finally in startDetachedFusion,
  // so it also runs if we throw before reaching here (consultation finding #2).

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
