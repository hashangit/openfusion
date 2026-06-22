// GET /api/providers and /api/providers/:provider/models — passthrough to pi-ai + custom providers.
import { Router } from "express";
import { listProviders, listModels } from "../../providers/pi-ai-bridge.js";
import { CUSTOM_PROVIDERS, KEYLESS_PROVIDERS } from "../../providers/custom-providers.js";

export function providersRouter(): Router {
  const r = Router();

  r.get("/", (_req, res) => {
    const providers = listProviders();
    // Enrich with metadata from custom provider definitions (name, description, keyless).
    const enriched = providers.map((id) => {
      const custom = CUSTOM_PROVIDERS[id];
      return {
        id,
        name: custom?.name ?? id,
        description: custom?.description ?? undefined,
        keyless: KEYLESS_PROVIDERS.has(id),
      };
    });
    res.json({ providers: enriched });
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
