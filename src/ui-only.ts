#!/usr/bin/env node
// Standalone OpenFusion dashboard (always-on, no MCP stdio transport).
// Useful when you want the config/stats UI running even without an MCP client connected.
// Shares the same on-disk SQLite + config + secrets as the MCP server.
import { startUiServer } from "./server/ui-server.js";
import { printStartupBanner } from "./util/startup.js";

async function main(): Promise<void> {
  await printStartupBanner();
  await startUiServer();
  console.error("OpenFusion dashboard running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
