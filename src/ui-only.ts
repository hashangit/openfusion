#!/usr/bin/env node
// Standalone OpenFusion dashboard (always-on, no MCP stdio transport).
// Useful when you want the config/stats UI running even without an MCP client connected.
// Shares the same on-disk SQLite + config + secrets as the MCP server.
import { startUiServer } from "./server/ui-server.js";
import { printStartupBanner } from "./util/startup.js";
import { registerCustomProviders, registerConfigModels } from "./providers/pi-ai-bridge.js";
import { loadConfig } from "./config/store.js";

async function main(): Promise<void> {
  registerCustomProviders();

  // Register any custom provider models from the saved config so resolveModel()
  // works at fusion time without requiring a prior UI call to /models.
  try {
    const cfg = loadConfig();
    registerConfigModels(cfg);
  } catch {
    // Config may not exist yet (first run) — that's fine.
  }
  await printStartupBanner();
  await startUiServer();
  console.error("OpenFusion dashboard running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
