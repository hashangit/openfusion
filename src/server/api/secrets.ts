// GET (masked presence only) / PUT /api/secrets — provider API keys (Constitution IV).
import { Router } from "express";
import { loadConfig } from "../../config/store.js";
import { maskedPresence, setProviderKey } from "../../config/secrets.js";

export function secretsRouter(): Router {
  const r = Router();

  // Masked presence only — NEVER the raw key.
  r.get("/", (_req, res) => {
    const config = loadConfig();
    res.json(maskedPresence(config));
  });

  // Set (or clear with null/empty) one provider's key. Encrypted before write.
  r.put("/", (req, res) => {
    const { provider, apiKey } = req.body ?? {};
    if (!provider || typeof provider !== "string") {
      const e = new Error("provider is required");
      (e as Error & { code?: string }).code = "VALIDATION";
      throw e;
    }
    setProviderKey(provider, typeof apiKey === "string" ? apiKey : null);
    const config = loadConfig();
    res.json(maskedPresence(config));
  });

  return r;
}
