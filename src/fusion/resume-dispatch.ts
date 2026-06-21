// Feature 008 — the `_resume_from` dispatch wrapper over the SDK's CallToolRequest handler.
//
// WHY THIS MODULE EXISTS (T011a — read before touching):
//
// The SDK's McpServer routes a `tools/call` for a `taskSupport:'optional'` tool like this
// (node_modules/.../sdk/dist/esm/server/mcp.js:100-123):
//
//   const isTaskRequest = !!request.params.task;        // codex/ZCode send task:None → false
//   const isTaskHandler = 'createTask' in tool.handler; // true (fusion registers via registerToolTask)
//   if (taskSupport === 'optional' && !isTaskRequest && isTaskHandler) {
//     return await this.handleAutomaticTaskPolling(tool, request, extra);   // ← BLOCKS until terminal
//   }
//
// `handleAutomaticTaskPolling` calls createTask, then POLL-LOOPS (5s default) until the task
// is terminal, THEN returns the final CallToolResult. That blocking poll IS the timeout bug
// feature 008 exists to fix — a non-Tasks client's `tools/call` never returns early enough
// for the agent to re-call with `_resume_from`. The blocking loop is the whole problem.
//
// We CANNOT fix this inside createTask: the SDK calls createTask identically for both Tasks
// requests and auto-poll requests (params.task is NOT forwarded to the handler), so createTask
// cannot tell them apart to return a deferred `processing` result for one and a working task
// for the other.
//
// So we replace the SDK's installed CallToolRequest handler AFTER registration: capture it,
// install a wrapper that peeks at request.params BEFORE the SDK's routing runs, and for the
// three non-Tasks fusion cases (kickoff / retrieval / unconfigured-kickoff) returns directly
// WITHOUT delegating. Every other call (Tasks clients, all other tools, malformed requests)
// is forwarded to the captured SDK handler unchanged — preserving CreateTaskResult +
// tasks/result byte-for-byte (FR-013/SC-007).
//
// =================================================================================================
// ⚠️  SDK COUPLING — READ BEFORE UPGRADING @modelcontextprotocol/sdk
// =================================================================================================
// This module reaches into the SDK's installed request-handler map:
//   - `server.server._requestHandlers.get("tools/call")` — the SDK's wrapped CallToolRequest
//     handler, captured post-registration. The leading `_` is the SDK's own "private" signal;
//     we read it deliberately and defensively (see installResumeDispatch).
//   - `server.server.setRequestHandler(CallToolRequestSchema, wrapper)` — the PUBLIC API for
//     replacing a handler. Idempotent; replaces any previous handler (protocol.js:886-893).
//
// The wrapper's contract with the captured SDK handler is narrow and structural:
//   - It receives the already-parsed request (the SDK wraps with safeParseAsync) + the
//     handler extra (the SDK's RequestHandlerExtra).
//   - It returns a CallToolResult OR a CreateTaskResult (the SDK returns either shape).
//
// ON SDK UPGRADE — verify these three things still hold (see specs/008-async-fusion-results/
// research.md R-001 source-trace method for the technique):
//   1. The CallToolRequest handler is installed EAGERLY at first-tool registration (mcp.js
//      `_createRegisteredTool` → `setToolRequestHandlers`). If it becomes lazy (installed on
//      first connect), installResumeDispatch must run AFTER connect, not after registration.
//   2. The handler key is still the string "tools/call" in _requestHandlers. If the SDK
//      changes to per-tool handlers or a different key shape, update `CALL_TOOL_METHOD`.
//   3. `request.params.task` still discriminates Tasks vs non-Tasks calls, and the SDK still
//      BLOCKS non-Tasks calls via handleAutomaticTaskPolling. If the SDK removes the blocking
//      path (e.g. non-Tasks calls fall through to the normal handler), this wrapper becomes a
//      no-op pass-through and can be deleted.
//
// A `canary` test (resume-dispatch.test.ts) asserts the captured handler exists and is a
// function after installResumeDispatch runs — if the SDK changes the handler shape, the canary
// fails at test time, not at runtime in production.
// =================================================================================================
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startDetachedFusion } from "./task-runner.js";
import { isConfigured } from "../config/completeness.js";
import { loadConfig } from "../config/store.js";
import { paths } from "../util/paths.js";
import { awaitTerminal, getJob, markRetrieved, RESUME_LONG_POLL_MS, RESUME_STALL_MS } from "./resume-store.js";
import { shapeForRetrieval, parallelKickoff, sequentialKickoff, PARALLEL_RETRY_AFTER_MS } from "./resume-shapes.js";
import type { ResumeShape } from "./resume-shapes.js";
import type { DB } from "../store/db.js";
import { computeSerialBudgetMs } from "./fanout.js";

/** The JSON-RPC method key the SDK installs the CallToolRequest handler under. */
const CALL_TOOL_METHOD = "tools/call";

/** The args shape the wrapper reads off request.params.arguments. */
interface FusionArgs {
  prompt?: string;
  context?: string;
  persona?: string;
  _resume_from?: string;
}

/** A minimal CallToolResult the wrapper returns directly (matches the SDK's shape). */
interface CallToolResultLike {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/** Options passed from createMcpServer into installResumeDispatch. */
export interface ResumeDispatchOptions {
  db: DB;
  openBrowserOnNeedsConfig?: boolean;
}

/**
 * Install the `_resume_from` dispatch wrapper on the server's CallToolRequest handler.
 * MUST run AFTER the fusion tool is registered (so the SDK's handler is installed) and
 * BEFORE server.connect (so no client call can race the replacement — B3-style ordering).
 *
 * Returns a boolean indicating whether the install succeeded. On failure (the SDK's handler
 * shape changed on upgrade), it logs an error and returns false — the server still works,
 * it just doesn't get the `_resume_from` path (non-Tasks clients fall back to the SDK's
 * blocking auto-poll, i.e. the pre-008 behavior). The canary test catches this at test time.
 */
export function installResumeDispatch(server: McpServer, opts: ResumeDispatchOptions): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lowLevel = (server as unknown as { server: any }).server;
  const installed = lowLevel?._requestHandlers?.get(CALL_TOOL_METHOD);
  if (typeof installed !== "function") {
    console.error(
      `[resume-dispatch] SDK CallToolRequest handler not found at '_requestHandlers.get("${CALL_TOOL_METHOD}")'. ` +
        `The _resume_from path is DISABLED — non-Tasks clients will fall back to the SDK's blocking auto-poll (pre-008 behavior). ` +
        `See src/fusion/resume-dispatch.ts header (SDK COUPLING) and verify on SDK upgrade.`,
    );
    return false;
  }

  // Capture the SDK's handler so we can delegate the non-_resume_from cases to it unchanged.
  // Every call we DON'T handle (Tasks clients, other tools, malformed requests) flows through
  // here exactly as the SDK intended — FR-013/SC-007 are preserved by delegation, not reimpl.
  const sdkHandler = installed as (request: unknown, extra: unknown) => Promise<unknown>;

  const wrapper = async (request: unknown, extra: unknown): Promise<unknown> => {
    // Peek at the request BEFORE the SDK's routing runs. We only intercept the narrow case:
    // a NON-Tasks call (no params.task) to the FUSION tool. Everything else delegates.
    const params = (request as { params?: { name?: string; arguments?: FusionArgs; task?: unknown } })?.params;
    const toolName = params?.name;
    const isTasksRequest = params?.task !== undefined && params?.task !== null;
    if (toolName !== "fusion" || isTasksRequest) {
      return sdkHandler(request, extra); // delegate: Tasks client, other tool, or malformed
    }

    const args = params?.arguments ?? {};
    const db = opts.db;

    // --- Retrieval branch (T012): _resume_from present → read the durable job, map to shape.
    if (args._resume_from) {
      return handleRetrieval(db, args._resume_from);
    }

    // --- Kickoff branch (T011): non-Tasks fusion start → dispatch detached, return processing.
    return handleKickoff(db, args, opts.openBrowserOnNeedsConfig);
  };

  // Replace the SDK's installed handler with the wrapper. setRequestHandler is the public API
  // and is idempotent (replaces any previous handler — protocol.js:886-893).
  lowLevel.setRequestHandler(CallToolRequestSchema, wrapper);
  return true;
}

/**
 * T012 — the retrieval branch. Single retrieval site (INV-1): reads the durable job,
 * bounded-long-polls in parallel mode (returns processing on timeout), returns processing
 * immediately in sequential mode (ETA-guided, no long-poll — FR-005). Maps status→shape.
 *
 * `prompt`/`context`/`persona` are ignored when _resume_from is present (FR-002).
 */
async function handleRetrieval(db: DB, referenceId: string): Promise<CallToolResultLike> {
  // Peek the job first to decide the retrieval cadence. Sequential mode is ETA-guided (no
  // long-poll — FR-005); parallel mode bounded-long-polls. A terminal job returns immediately
  // in BOTH modes (the completed fast-path, SC-003).
  const peek = getJob(db, referenceId);
  if (!peek) {
    return toResult(shapeForRetrieval(undefined, referenceId));
  }
  if (peek.status !== "processing") {
    // Terminal: mark retrieved + return the mapped shape immediately. No awaitTerminal(0)
    // indirection — the peek already holds the terminal job, and a second getJob + setTimeout(0)
    // + third getJob just adds latency to the SC-003 fast-path (scrutinize fix).
    markRetrieved(db, referenceId);
    return toResult(shapeForRetrieval(peek, referenceId, { executionMode: peek.execution_mode }));
  }

  // Processing: branch on mode.
  if (peek.execution_mode === "sequential") {
    // Sequential: ETA-guided, IMMEDIATE return (no long-poll). remainingMs = eta_ms - elapsed,
    // floored at 1 min so the wording is sane for a job near completion.
    const elapsed = Date.now() - Date.parse(peek.created_at);
    const remainingMs = Math.max(60_000, (peek.eta_ms ?? 0) - elapsed);
    return toResult(
      shapeForRetrieval(peek, referenceId, { executionMode: "sequential", remainingMs }),
    );
  }

  // Parallel: bounded long-poll. The job may transition during the wait (waiter resolves on
  // markTerminal); on timeout it returns the parallel processing shape. awaitTerminal owns
  // markRetrieved + the stalled circuit + TTL eviction for the terminal case.
  const job = await awaitTerminal(db, referenceId, RESUME_LONG_POLL_MS);
  return toResult(shapeForRetrieval(job ?? peek, referenceId, { executionMode: "parallel" }));
}

/**
 * T011 — the kickoff branch. For a non-Tasks client calling fusion({prompt}):
 *   (a) Synchronous config-gate pre-check (F4): if unconfigured, open the dashboard and
 *       return the error shape WITHOUT allocating a fusion_jobs row or dispatching.
 *   (b) Allocate the activity, write the kickoff row, dispatch the detached runner, return
 *       the mode-aware processing shape IMMEDIATELY (≈1s — no provider work in the call path).
 *
 * This is what stops the codex/ZCode timeout: the call returns before any fan-out.
 */
async function handleKickoff(
  db: DB,
  args: FusionArgs,
  openBrowserOnNeedsConfig?: boolean,
): Promise<CallToolResultLike> {
  // FR-002 corollary: prompt presence is enforced HERE (the schema made it optional so the
  // agent doesn't resend it on every poll, but a fresh kickoff still requires one).
  if (!args.prompt || args.prompt.trim().length === 0) {
    return {
      isError: true,
      content: [{ type: "text", text: "Missing required argument: prompt. Pass a prompt to start a fusion, or _resume_from: <id> to retrieve a prior result." }],
    };
  }

  // F4: cheap synchronous pre-check (the detached runFusion runs AFTER kickoff returns, so it
  // can't observe its own needsConfig). Matches the blocking-path UX: browser opens on
  // first-run misconfig. A config-becomes-invalid mid-flight fusion still surfaces via retrieval.
  const config = loadConfig();
  const gate = isConfigured(config, paths.secrets(), paths.masterKey());
  if (!gate.configured) {
    if (openBrowserOnNeedsConfig !== false) {
      try {
        const { openDashboard } = await import("../util/browser.js");
        await openDashboard("http://localhost:9077");
      } catch {
        // best-effort; the error text below still points the user at the URL.
      }
    }
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `OpenFusion isn't configured: ${gate.reasons.join("; ")}. Open http://localhost:9077 (or run \`openfusion configure\`) to set up candidates, a judge, and API keys.`,
        },
      ],
    };
  }

  // Read the execution mode from the config snapshot (R-004 — drives the kickoff shape).
  const executionMode = (config.settings.executionMode ?? "parallel") as "parallel" | "sequential";
  const candidateCount = (config.candidates ?? []).filter((c) => c.enabled !== false).length;
  const etaMs = executionMode === "sequential" ? computeSerialBudgetMs(candidateCount) : null;
  // scrutinize fix: the stalled-circuit threshold must accommodate a worker exhausting all
  // retries (3 attempts) without a progress callback. workerTimeoutMs × 3 covers both modes —
  // parallel (one slow worker × 3 retries) and sequential (one candidate × 3 retries, no
  // mid-candidate report). Floored at RESUME_STALL_MS so a tiny timeout doesn't under-threshold.
  const workerTimeoutMs = config.settings.workerTimeoutMs ?? 300_000;
  const stallThresholdMs = Math.max(RESUME_STALL_MS, workerTimeoutMs * 3);

  // Dispatch detached. startDetachedFusion allocates the activity row (the reference id —
  // INV-2: identity collapse, the runner owns the id), writes the kickoff fusion_jobs row
  // (m12 — first write), then fire-and-forgets runFusion. `extra` is undefined — the
  // `_resume_from` path skips the Tasks substrate entirely; fusion_jobs is its sole record.
  // The returned activityId is the reference id we put in the kickoff shape — it MUST be the
  // same id the runner writes terminal to (the bug this guards against: a second allocateActivity
  // here would mint a different id, and retrieval would never find the row).
  let activityId: string;
  try {
    const result = await startDetachedFusion(
      {
        prompt: args.prompt,
        context: args.context,
        persona: args.persona,
        db,
        openBrowserOnNeedsConfig,
      },
      undefined,
      { executionMode, etaMs, stallThresholdMs },
    );
    activityId = result.activityId;
  } catch (err: unknown) {
    console.error(`[resume-dispatch] kickoff dispatch failed:`, err);
    return {
      isError: true,
      content: [{ type: "text", text: `Failed to start fusion: ${err instanceof Error ? err.message : String(err)}. Retry your original query.` }],
    };
  }

  // Return the mode-aware kickoff shape IMMEDIATELY. The work is detached; the call path did
  // no provider work (F6 — ≈1s honest target, not "sub-second").
  const shape = executionMode === "sequential" && etaMs !== null
    ? sequentialKickoff(activityId, etaMs)
    : parallelKickoff(activityId, PARALLEL_RETRY_AFTER_MS);
  return toResult(shape);
}

/** Convert a ResumeShape to the bare CallToolResult the SDK expects, threading _meta. */
function toResult(shape: ResumeShape): CallToolResultLike {
  const result: CallToolResultLike = { content: shape.content };
  if (shape._meta) result._meta = shape._meta;
  return result;
}
