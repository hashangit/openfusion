#!/usr/bin/env node
// OpenFusion MCP server entry. Boots the stdio MCP server (fusion + open_dashboard tools)
// and the Express UI server on 127.0.0.1:9077 (config + stats dashboard) in one process.
//
// stdout is the MCP JSON-RPC channel — ALL logs go to stderr (AGENTS.md conventions).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server/mcp-server.js";
import { startUiServer } from "./server/ui-server.js";
import { printStartupBanner } from "./util/startup.js";
import { registerCustomProviders } from "./providers/pi-ai-bridge.js";

async function main(): Promise<void> {
  // Register custom providers (rapid-mlx, ollama-cloud) so they appear in the UI
  // and resolve correctly at fusion time.
  registerCustomProviders();

  // First-run banner (stderr) + auto-open the dashboard on a fresh install.
  await printStartupBanner();

  const server = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The UI server is optional at startup. If it isn't ready, log and continue —
  // the MCP tool still works for fusions.
  try {
    await startUiServer();
  } catch (e) {
    console.error(`OpenFusion UI server not started: ${(e as Error).message}`);
  }

  console.error("OpenFusion MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
