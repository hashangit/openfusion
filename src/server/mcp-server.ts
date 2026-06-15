// MCP server: registers the `fusion` + `open_dashboard` tools over stdio.
// stdout is the JSON-RPC channel — ALL logs go to stderr (AGENTS.md conventions).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runFusion } from "../fusion/fusion.js";
import { loadConfig, emptyConfig } from "../config/store.js";
import { openDatabase } from "../store/db.js";
import { paths, ensureHome } from "../util/paths.js";
import type { DB } from "../store/db.js";

const UI_URL = "http://localhost:9077";

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
  args: { prompt: string; context?: string },
  extra: ToolExtra,
  deps: { db: DB; openBrowserOnNeedsConfig?: boolean },
): Promise<{ isError?: boolean; content: { type: "text"; text: string }[] }> {
  const report = makeProgressReporter(extra);
  const config = loadConfig();
  const result = await runFusion({
    prompt: args.prompt,
    context: args.context,
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
  const server = new McpServer({ name: "openfusion", version: "0.1.0" });
  if (!options.db) ensureHome(); // make sure ~/.openfusion exists before opening the DB
  const db = options.db ?? openDatabase(paths.db());

  // Tool: fusion — fan-out + two-step judge.
  server.tool(
    "fusion",
    "Fan a prompt out to 2-5 candidate models, run a two-step judge (analysis then synthesis), and return one consolidated answer. Slower and costlier than a single model call (2-3x). Use for complex reasoning, deep research, cross-model verification, or high-stakes answers where consensus adds value. Do NOT use for routine lookups, single-turn Q&A, or trivial tasks. OpenFusion does not call tools — provide the prompt and any gathered context yourself.",
    fusionInputSchema,
    async (args, extra) => fusionToolHandler(args, extra as unknown as ToolExtra, { db, openBrowserOnNeedsConfig: options.openBrowserOnNeedsConfig }),
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
  const hasDisplay =
    process.platform === "darwin" ||
    !!process.env.DISPLAY ||
    !!process.env.FORCE_OPEN;
  if (!hasDisplay) return;
  try {
    const open = (await import("open")).default;
    await open(UI_URL);
  } catch {
    /* best-effort; the URL is already in the tool response */
  }
}

export { emptyConfig, UI_URL };
