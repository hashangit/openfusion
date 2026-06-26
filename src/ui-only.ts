#!/usr/bin/env node
// Standalone OpenFusion dashboard (always-on, no MCP stdio transport).
// Useful when you want the config/stats UI running even without an MCP client connected.
// Shares the same on-disk SQLite + config + secrets as the MCP server.
import { startUiServer } from "./server/ui-server.js";
import { printStartupBanner } from "./util/startup.js";
import { registerConfigModels } from "./providers/pi-ai-bridge.js";
import { loadConfig } from "./config/store.js";

async function main(): Promise<void> {
  // Register any custom provider models referenced by the saved config so
  // resolveModel() works. loadConfig() returns an empty config (no throw) when
  // the file is absent (first run); a genuinely corrupt config.json fails loudly.
  registerConfigModels(loadConfig());
  await printStartupBanner();
  await startUiServer();
  console.error("OpenFusion dashboard running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
