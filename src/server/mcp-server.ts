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
import { resolvePersona, toLite, BUILTIN_PERSONAS, type PersonaLite } from "../fusion/personas.js";
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
      "To see available personas, call `list_personas`; pass `persona=<id>` to override the active one (subject to the user's persona policy in the dashboard). Defaults to the active persona.",
    ),
};

/**
 * The pre-006 fusion tool description (captured for SC-006: the new description must be
 * strictly shorter and must NOT inline the persona id enumeration). Used by the
 * `fusion description trims tokens` test.
 */
export const PRE_006_FUSION_DESCRIPTION =
  "Fan a prompt out to 2-5 candidate models, run a two-step judge (analysis then synthesis), and return one consolidated answer. Slower and costlier than a single model call (2-3x). Use for complex reasoning, deep research, cross-model verification, or high-stakes answers where consensus adds value. Do NOT use for routine lookups, single-turn Q&A, or trivial tasks. OpenFusion does not call tools — provide the prompt and any gathered context yourself. Optional 'persona' (e.g. 'qa', 'researcher', 'pm') tailors the worker + judge prompts to the task; defaults to the active persona in the dashboard.";

/**
 * The post-006 fusion tool description: persona enumeration removed (agents discover via
 * `list_personas`), replaced with a concise discovery nudge. Strictly shorter than
 * PRE_006_FUSION_DESCRIPTION (SC-006).
 */
export const FUSION_DESCRIPTION =
  "Fan a prompt out to 2-5 candidate models, run a two-step judge (analysis then synthesis), and return one consolidated answer. Slower and costlier than a single model call (2-3x). Use for complex reasoning, deep research, cross-model verification, or high-stakes answers where consensus adds value. Do NOT use for routine lookups, single-turn Q&A, or trivial tasks. Call `list_personas` first; pass `persona=<id>` to override.";

/**
 * The MCP `extra` shape we depend on (progress token + sendNotification).
 * Kept structural/loose so it accepts both the SDK's typed handler extra and
 * mocked test extras. The SDK's extra is structurally compatible with this.
 */
export interface ToolExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: unknown) => Promise<unknown>;
  /**
   * Optional elicitation sender (feature 006). The server wires this only when the
   * client advertises the elicitation.form capability. Returns the user's choice or
   * rejects (caller treats reject as "keep-strict"). Absent on non-elicitation clients.
   */
  elicitRelaxStrict?: (requested: string, used: string) => Promise<"relax" | "keep-strict">;
}

/**
 * Build the engine→transport `onPersonaEvent` callback from a handler extra (feature 006).
 * Emits a `notifications/message` warning for every event; sends a relax-strict elicitation
 * when the event is an elicitation-request AND the extra supports elicitation. The result
 * drives the in-engine re-resolution ("relax" → honor the requested persona).
 */
function makePersonaEventHandler(
  extra: ToolExtra,
): ((e: import("../fusion/persona-policy.js").PersonaEvent) => Promise<import("../fusion/persona-policy.js").PersonaEventResult>) | undefined {
  const send = extra.sendNotification;
  const elicit = extra.elicitRelaxStrict;
  if (!send && !elicit) return undefined;
  return async (e) => {
    // Always emit the warning notification (best-effort) — carries requested/used/reason.
    if (send) {
      void send({
        method: "notifications/message",
        params: {
          level: "warning",
          data: { requested: "requested" in e ? e.requested : undefined, used: e.used, reason: "kind" in e && e.kind === "elicitation-request" ? "strict-enforced" : e.kind === "warning" ? e.source : undefined },
        },
      }).catch(() => {}); // fire-and-forget; warnings must not break fusion (Constitution III).
    }
    // Elicit only for strict-enforced (elicitation-request) + when the client supports it.
    if (e.kind === "elicitation-request" && elicit) {
      return elicit(e.requested, e.used);
    }
    return undefined;
  };
}

/** The fusion tool handler, extracted so tests can call it with a mocked extra. */
export async function fusionToolHandler(
  args: { prompt: string; context?: string; persona?: string },
  extra: ToolExtra,
  deps: { db: DB; openBrowserOnNeedsConfig?: boolean },
): Promise<{ isError?: boolean; content: { type: "text"; text: string }[] }> {
  const report = makeProgressReporter(extra);
  const onPersonaEvent = makePersonaEventHandler(extra);
  const config = loadConfig();
  const result = await runFusion({
    prompt: args.prompt,
    context: args.context,
    persona: args.persona,
    config,
    db: deps.db,
    onProgress: report,
    onPersonaEvent,
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

/**
 * The list_personas tool handler (feature 006). Returns a JSON array of PersonaLite —
 * {id, name, description, builtin, active} — with NO prompt fields (SC-001). Discovery is
 * never gated by personaPolicy (FR-016); enforcement happens at fusion time only.
 *
 * Exported so tests can call it directly without spinning up the full server.
 */
export function listPersonasToolHandler(config: {
  personas?: readonly { id: string; name: string; description?: string; builtin?: boolean }[];
  settings?: { activePersona?: string };
}): { content: { type: "text"; text: string }[] } {
  // Merge missing builtins into the stored list — a non-empty config.personas (v3 configs
  // persist the builtins) would otherwise shadow a newly shipped builtin. Mirrors the
  // REST `withBuiltins` path in server/api/personas.ts so MCP and UI agree (FR-001).
  const stored = [...(config.personas ?? [])];
  const storedIds = new Set(stored.map((p) => p.id));
  const personas = [...stored, ...BUILTIN_PERSONAS.filter((b) => !storedIds.has(b.id))];
  const active = resolvePersona({
    personas: personas as never,
    activeId: config.settings?.activePersona,
  });
  const list: PersonaLite[] = personas.map((p) => toLite(p as never, active.id));
  return { content: [{ type: "text", text: JSON.stringify(list) }] };
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
      description: FUSION_DESCRIPTION,
      inputSchema: fusionInputSchema,
      execution: { taskSupport: "optional" },
    },
    {
      // NOTE: param types are explicit because the SDK's experimental registerToolTask
      // overloads don't infer the handler signature reliably across zod v3/v4 compat.
      // Cast as ToolTaskHandler to assert the contract; runtime shapes are correct.
      // REVISIT on SDK upgrade: if the cast stops compiling, the handler interface
      // changed — fix the handler, don't just widen the cast. See research.md R-010.
      createTask: async (
        args: { prompt: string; context?: string; persona?: string },
        extra: CreateTaskRequestHandlerExtra,
      ) => {
        // Feature 006: build the persona-event callback from this request's extra + the
        // server's elicitation capability, and forward it so the detached fusion enforces
        // persona policy identically to the blocking path (FR-009).
        const taskExtra: TaskHandlerExtra & ToolExtra = {
          taskStore: (extra as unknown as TaskHandlerExtra).taskStore,
          sendNotification: extra.sendNotification as ToolExtra["sendNotification"],
          elicitRelaxStrict: makeElicitRelaxStrict(server),
        };
        const task = await startDetachedFusion(
          {
            prompt: args.prompt,
            context: args.context,
            persona: args.persona,
            db,
            openBrowserOnNeedsConfig: options.openBrowserOnNeedsConfig,
            onPersonaEvent: makePersonaEventHandler(taskExtra),
          },
          taskExtra,
        );
        return { task };
      },
      getTask: async (_args: unknown, extra: TaskRequestHandlerExtra) =>
        extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_args: unknown, extra: TaskRequestHandlerExtra) =>
        extra.taskStore.getTaskResult(extra.taskId),
    } as unknown as ToolTaskHandler<typeof fusionInputSchema>,
  );

  // Compile-time canary: fails to compile if ToolTaskHandler's shape changes on SDK
  // upgrade, surfacing a break at build time rather than runtime. No-op at runtime.
  const _fusionTaskHandlerShapeCanary: ToolTaskHandler<typeof fusionInputSchema> = {
    createTask: (() => { throw new Error("canary, never called"); }) as never,
    getTask: (() => { throw new Error("canary, never called"); }) as never,
    getTaskResult: (() => { throw new Error("canary, never called"); }) as never,
  };
  void _fusionTaskHandlerShapeCanary;

  // Tool: list_personas (feature 006) — read-only persona discovery for MCP clients.
  // Returns a JSON array of {id, name, description, builtin, active} — no prompt fields.
  // Never gated by personaPolicy (FR-016); enforcement is at fusion time only.
  server.tool(
    "list_personas",
    "List available personas as a JSON array of {id, name, description, builtin, active}. Call this to discover which personas exist before passing `persona=<id>` to `fusion`. Exactly one entry has active=true (the dashboard's current selection). Does not expose prompt text.",
    {},
    async () => listPersonasToolHandler(loadConfig()),
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

/**
 * Build the relax-strict elicitation sender (feature 006, T026). Returns undefined when the
 * client does NOT advertise the elicitation.form capability (notification-only fallback).
 *
 * Capability detection is lazy: client caps arrive during MCP initialize, which happens
 * AFTER server construction. So we read `server.server.getClientCapabilities()` at call
 * time (when a strict-enforcement event fires), not at registration time (research.md R-002).
 *
 * The sender dedupes via `askRelaxStrict` (SC-004 — at most one prompt per session).
 */
function makeElicitRelaxStrict(
  server: McpServer,
): ToolExtra["elicitRelaxStrict"] {
  return async (requested, used) => {
    // Lazy capability check — read at call time, not registration time.
    const caps = server.server.getClientCapabilities();
    if (!caps?.elicitation?.form) return "keep-strict"; // no elicitation → strict stays

    const { askRelaxStrict } = await import("../fusion/persona-policy.js");
    return askRelaxStrict(async () => {
      // Send the elicitation form per contracts/mcp-persona-tools.md.
      // The SDK's server.elicitUrl/elicitation helpers only support url/form flavors on
      // newer versions; on 1.29.0 we send a raw elicitation/create via server.request and
      // cast params to unknown (the runtime shape matches the MCP spec; the SDK's typed
      // overload is narrower than the spec here — see research.md R-003).
      const result = await server.server.request(
        { method: "elicitation/create" },
        {
          form: {
            title: "OpenFusion: relax persona policy for this session?",
            description: `An agent requested the '${requested}' persona, but your persona policy is set to strict (active: '${used}'). Allow the agent to override for the rest of this session?`,
            fields: {
              choice: {
                type: "string",
                enum: ["relax", "keep-strict"],
                default: "keep-strict",
              },
            },
          },
        } as unknown as never,
      );
      const choice = (result as { content?: { choice?: string } })?.content?.choice;
      return choice === "relax" ? "relax" : "keep-strict";
    });
  };
}

/** Open the dashboard URL in a browser when a display is present; best-effort. */
async function maybeOpenBrowser(): Promise<void> {
  const { openDashboard } = await import("../util/browser.js");
  await openDashboard(UI_URL);
}

export { emptyConfig, UI_URL };
