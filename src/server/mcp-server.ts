// MCP server: registers the `fusion` + `open_dashboard` tools over stdio.
// stdout is the JSON-RPC channel — ALL logs go to stderr (AGENTS.md conventions).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import type {
  CreateTaskRequestHandlerExtra,
  TaskRequestHandlerExtra,
  ToolTaskHandler,
} from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import { z } from "zod";
import { runFusion } from "../fusion/fusion.js";
import { startDetachedFusion, type TaskHandlerExtra } from "../fusion/task-runner.js";
import { loadConfig, emptyConfig } from "../config/store.js";
import { openDatabase } from "../store/db.js";
import { paths, ensureHome } from "../util/paths.js";
import { VERSION } from "../util/version.js";
import type { DB } from "../store/db.js";

const UI_URL = "http://localhost:9077";

// Feature 005 (research.md R-010): the server MUST declare this capability in its options
// or task-augmented `tools/call` requests fail with "Server does not support task creation".
// The capability value is an object ({}), NOT boolean true — see R-010 finding #2.
const TASKS_SERVER_CAP = { tasks: { requests: { tools: { call: {} } } } } as const;

export interface McpServerOptions {
  /** Override the DB (tests pass a temp one). Defaults to the on-disk OpenFusion DB. */
  db?: DB;
  /** Whether to attempt opening a browser for first-run config. Default true. */
  openBrowserOnNeedsConfig?: boolean;
}

/** The fusion tool's input schema (Zod). Exported so callers/tests can validate inputs. */
export const fusionInputSchema = {
  prompt: z.string().describe("The prompt to fuse across candidate models"),
  context: z
    .string()
    .optional()
    .describe(
      "Optional background context, prior reasoning, or tool results the client has already gathered. Included with the prompt for each candidate. OpenFusion does not gather information itself.",
    ),
  persona: z
    .string()
    .optional()
    .describe(
      "Persona id or name to use for this fusion (e.g. 'qa', 'researcher', 'pm'). A persona bundles the worker + analysis + synthesis system prompts. Defaults to the active persona set in the dashboard ('generalist' unless changed).",
    ),
};

/**
 * The MCP `extra` shape we depend on (progress token + sendNotification).
 * Kept structural/loose so it accepts both the SDK's typed handler extra and
 * mocked test extras. The SDK's extra is structurally compatible with this.
 */
export interface ToolExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: unknown) => Promise<unknown>;
}

/** The fusion tool handler, extracted so tests can call it with a mocked extra. */
export async function fusionToolHandler(
  args: { prompt: string; context?: string; persona?: string },
  extra: ToolExtra,
  deps: { db: DB; openBrowserOnNeedsConfig?: boolean },
): Promise<{ isError?: boolean; content: { type: "text"; text: string }[] }> {
  const report = makeProgressReporter(extra);
  const config = loadConfig();
  const result = await runFusion({
    prompt: args.prompt,
    context: args.context,
    persona: args.persona,
    config,
    db: deps.db,
    onProgress: report,
  });
  if (!result.ok) {
    const text = result.error ?? "Fusion failed.";
    if (result.needsConfig && deps.openBrowserOnNeedsConfig !== false) {
      await maybeOpenBrowser();
    }
    return { isError: true, content: [{ type: "text", text }] };
  }
  return { content: [{ type: "text", text: result.answer ?? "" }] };
}

/** The open_dashboard tool handler. */
export async function openDashboardToolHandler(): Promise<{ content: { type: "text"; text: string }[] }> {
  await maybeOpenBrowser();
  return { content: [{ type: "text", text: `Opened ${UI_URL} in your browser.` }] };
}

/** Build and connect an McpServer with the fusion + open_dashboard tools. */
export async function createMcpServer(options: McpServerOptions = {}): Promise<McpServer> {
  // Feature 005: taskStore + capabilities on the constructor (research.md R-010).
  // taskStore is the InMemoryTaskStore backing tasks/get + tasks/result.
  const server = new McpServer(
    { name: "openfusion", version: VERSION },
    { taskStore: new InMemoryTaskStore(), capabilities: TASKS_SERVER_CAP },
  );
  if (!options.db) ensureHome(); // make sure ~/.openfusion exists before opening the DB
  const db = options.db ?? openDatabase(paths.db());

  // Tool: fusion — task-capable (SEP-1686). taskSupport:'optional' means:
  //   - Tasks-aware client (sends `task` param) → CreateTaskResult returned synchronously,
  //     fusion runs detached, client fetches via tasks/result. No client-side timeout.
  //   - Non-Tasks client (no `task` param) → SDK auto-polls the same createTask handler
  //     and returns the final CallToolResult (handleAutomaticTaskPolling). Blocking path.
  server.experimental.tasks.registerToolTask(
    "fusion",
    {
      description:
        "Fan a prompt out to 2-5 candidate models, run a two-step judge (analysis then synthesis), and return one consolidated answer. Slower and costlier than a single model call (2-3x). Use for complex reasoning, deep research, cross-model verification, or high-stakes answers where consensus adds value. Do NOT use for routine lookups, single-turn Q&A, or trivial tasks. OpenFusion does not call tools — provide the prompt and any gathered context yourself. Optional 'persona' (e.g. 'qa', 'researcher', 'pm') tailors the worker + judge prompts to the task; defaults to the active persona in the dashboard.",
      inputSchema: fusionInputSchema,
      execution: { taskSupport: "optional" },
    },
    {
      // NOTE: param types are explicit because the SDK's experimental registerToolTask
      // overloads don't infer the handler signature reliably across zod v3/v4 compat.
      // Cast as ToolTaskHandler to assert the contract; runtime shapes are correct.
      createTask: async (
        args: { prompt: string; context?: string; persona?: string },
        extra: CreateTaskRequestHandlerExtra,
      ) => {
        const task = await startDetachedFusion(
          {
            prompt: args.prompt,
            context: args.context,
            persona: args.persona,
            db,
            openBrowserOnNeedsConfig: options.openBrowserOnNeedsConfig,
          },
          extra as unknown as TaskHandlerExtra,
        );
        return { task };
      },
      getTask: async (_args: unknown, extra: TaskRequestHandlerExtra) =>
        extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_args: unknown, extra: TaskRequestHandlerExtra) =>
        extra.taskStore.getTaskResult(extra.taskId),
    } as unknown as ToolTaskHandler<typeof fusionInputSchema>,
  );

  // Tool: open_dashboard — pop the config/stats UI in a browser.
  server.tool(
    "open_dashboard",
    "Open the OpenFusion configuration and usage dashboard in the user's browser (http://localhost:9077). Use when the user needs to configure candidates/judge/API keys or view usage stats.",
    {},
    async () => openDashboardToolHandler(),
  );

  return server;
}

/** Build a progress callback that emits notifications/progress (no-op if the client sent no token). */
function makeProgressReporter(extra: ToolExtra): ((progress: number, total: number, message: string) => void) {
  const token = extra._meta?.progressToken;
  const send = extra.sendNotification;
  if (token === undefined || !send) {
    return () => {};
  }
  return (progress, total, message) => {
    // Fire-and-forget; progress is best-effort (Constitution III).
    void send({
      method: "notifications/progress",
      params: { progressToken: token, progress, total, message },
    });
  };
}

/** Open the dashboard URL in a browser when a display is present; best-effort. */
async function maybeOpenBrowser(): Promise<void> {
  const { openDashboard } = await import("../util/browser.js");
  await openDashboard(UI_URL);
}

export { emptyConfig, UI_URL };
