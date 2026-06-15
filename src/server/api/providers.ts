// GET /api/providers and /api/providers/:provider/models — passthrough to pi-ai.
import { Router } from "express";
import { listProviders, listModels } from "../../providers/pi-ai-bridge.js";

export function providersRouter(): Router {
  const r = Router();

  r.get("/", (_req, res) => {
    res.json({ providers: listProviders() });
  });

  r.get("/:provider/models", (req, res) => {
    const provider = req.params.provider;
    try {
      res.json({ models: listModels(provider) });
    } catch (e) {
      const err = new Error((e as Error).message);
      (err as Error & { code?: string }).code = "UNKNOWN_PROVIDER";
      throw err;
    }
  });

  return r;
}
