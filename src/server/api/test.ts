// POST /api/test — validate a provider+model+key before the user commits it (FR-013).
import { Router } from "express";
import { testPing } from "../../providers/pi-ai-bridge.js";

export function testRouter(): Router {
  const r = Router();

  r.post("/", async (req, res) => {
    const { provider, model, apiKey } = req.body ?? {};
    if (!provider || !model || !apiKey) {
      const e = new Error("provider, model, and apiKey are required");
      (e as Error & { code?: string }).code = "VALIDATION";
      throw e;
    }
    const result = await testPing(provider, model, apiKey, 10_000);
    res.json(result);
  });

  return r;
}
