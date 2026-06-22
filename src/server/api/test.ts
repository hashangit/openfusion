// POST /api/test — validate a provider+model+key before the user commits it (FR-013).
import { Router } from "express";
import { testPing, effectiveApiKey } from "../../providers/pi-ai-bridge.js";

export function testRouter(): Router {
  const r = Router();

  r.post("/", async (req, res) => {
    const { provider, model, apiKey } = req.body ?? {};
    if (!provider || !model) {
      const e = new Error("provider and model are required");
      (e as Error & { code?: string }).code = "VALIDATION";
      throw e;
    }
    // Keyless providers (e.g. rapid-mlx) don't require an API key — supply a sentinel.
    // For others, apiKey is required.
    const resolvedKey = effectiveApiKey(provider, apiKey || undefined);
    if (!resolvedKey) {
      const e = new Error("apiKey is required for this provider");
      (e as Error & { code?: string }).code = "VALIDATION";
      throw e;
    }
    const result = await testPing(provider, model, resolvedKey, 10_000);
    res.json(result);
  });

  return r;
}
