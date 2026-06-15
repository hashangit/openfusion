// GET/PUT /api/config — read/write model choices (no secrets).
import { Router } from "express";
import { loadConfig, saveConfig, mergeAndValidate, emptyConfig } from "../../config/store.js";
import { isConfigured } from "../../config/completeness.js";

export function configRouter(): Router {
  const r = Router();

  // GET the current config (no secrets) + the configured flag.
  r.get("/", (_req, res) => {
    const config = loadConfig();
    res.json({ ...config, configured: isConfigured(config).configured });
  });

  // PUT a partial config patch. Fields not supplied are merged from the existing
  // config on disk; the result is validated leniently (RawConfigSchema) so that
  // incremental setup works — e.g. saving Candidates before a Judge is chosen.
  // Completeness (>=2 candidates + judge + keys) is gated by isConfigured() at
  // fusion time, NOT here (Constitution VI).
  r.put("/", (req, res) => {
    const merged = mergeAndValidate(loadConfig(), req.body);
    saveConfig(merged);
    const config = loadConfig();
    res.json({ ...config, configured: isConfigured(config).configured });
  });

  return r;
}

export { emptyConfig };

