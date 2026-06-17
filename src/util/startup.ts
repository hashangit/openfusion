// Startup banner + first-run guidance. Shared by the MCP server (index.ts)
// and the standalone dashboard (ui-only.ts). All output to stderr — stdout is
// either the MCP JSON-RPC channel or, for the UI bin, unused.
import { loadConfig } from "../config/store.js";
import { isConfigured } from "../config/completeness.js";
import { openfusionHome, paths } from "./paths.js";
import { VERSION } from "./version.js";
import { openDashboard, hasDisplay } from "./browser.js";
import { existsSync } from "node:fs";

export const UI_URL = "http://localhost:9077";

/**
 * Print the OpenFusion startup banner to stderr, and — on a true first run
 * (no config file) with a display present — open the dashboard in the browser.
 * Best-effort; never throws or blocks.
 */
export async function printStartupBanner(): Promise<void> {
  const home = openfusionHome();
  const firstRun = !existsSync(paths.config());
  const report = isConfigured(loadConfig());

  const lines = [
    "",
    `  OpenFusion v${VERSION}`,
    `  Data:    ${home}`,
  ];
  if (report.configured) {
    lines.push("  Status:  ● Configured — the fusion tool is ready.");
  } else if (firstRun) {
    lines.push(`  Status:  ○ First run — open ${UI_URL} to set up candidates, a judge, and API keys.`);
  } else {
    lines.push(`  Status:  ○ Not configured (${report.reasons.join("; ")}).`);
    lines.push(`           Open ${UI_URL} to finish setup.`);
  }
  lines.push("");
  console.error(lines.join("\n"));

  // First-run only: pop the dashboard if we're in a GUI session.
  if (firstRun && !report.configured && hasDisplay()) {
    void openDashboard(UI_URL);
  }
}
