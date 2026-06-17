// GET /api/status — one lightweight call for version + configured-state + paths.
// Used by the dashboard, the agent, and CLI health checks.
import { Router } from "express";
import { loadConfig } from "../../config/store.js";
import { isConfigured } from "../../config/completeness.js";
import { paths, openfusionHome } from "../../util/paths.js";
import { VERSION } from "../../util/version.js";
import { existsSync } from "node:fs";

export function statusRouter(): Router {
  const r = Router();
  r.get("/", (_req, res) => {
    const config = loadConfig();
    const report = isConfigured(config);
    res.json({
      ok: true,
      version: VERSION,
      home: openfusionHome(),
      configured: report.configured,
      ...(report.reasons.length ? { reasons: report.reasons } : {}),
      firstRun: !existsSync(paths.config()),
      dbPath: paths.db(),
    });
  });
  return r;
}
