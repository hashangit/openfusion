// GET /api/providers, GET /api/providers/:provider/models, and
// GET /api/providers/:provider/discover — provider listing, model listing,
// and dynamic model discovery for custom providers.
import { Router } from "express";
import { listProviders, listModels, registerCustomModel } from "../../providers/pi-ai-bridge.js";
import { CUSTOM_PROVIDERS, KEYLESS_PROVIDERS, discoverModels } from "../../providers/custom-providers.js";
import { getKey } from "../../config/secrets.js";
import { effectiveApiKey } from "../../providers/pi-ai-bridge.js";

export function providersRouter(): Router {
  const r = Router();

  // GET /api/providers — list all providers with metadata.
  r.get("/", (_req, res) => {
    const providers = listProviders();
    // Enrich with metadata from custom provider definitions (name, description, keyless, discoverable).
    const enriched = providers.map((id) => {
      const custom = CUSTOM_PROVIDERS[id];
      return {
        id,
        name: custom?.name ?? id,
        description: custom?.description ?? undefined,
        keyless: KEYLESS_PROVIDERS.has(id),
        discoverable: custom?.discoverable ?? false,
      };
    });
    res.json({ providers: enriched });
  });

  // GET /api/providers/:provider/models — list models for a built-in provider.
  // Custom providers use /discover instead (their models aren't static).
  r.get("/:provider/models", (req, res) => {
    const provider = req.params.provider;
    // For custom discoverable providers, return empty — use /discover.
    if (CUSTOM_PROVIDERS[provider]?.discoverable) {
      res.json({ models: [] });
      return;
    }
    try {
      res.json({ models: listModels(provider) });
    } catch (e) {
      const err = new Error((e as Error).message);
      (err as Error & { code?: string }).code = "UNKNOWN_PROVIDER";
      throw err;
    }
  });

  // GET /api/providers/:provider/discover — dynamically discover models from a
  // custom provider's /v1/models endpoint. Also registers discovered models with
  // the pi-ai bridge so resolveModel() works at fusion time.
  r.get("/:provider/discover", async (req, res) => {
    const provider = req.params.provider;
    const def = CUSTOM_PROVIDERS[provider];
    if (!def || !def.discoverable) {
      res.status(404).json({ error: `Provider '${provider}' does not support model discovery.` });
      return;
    }
    // Resolve an API key: for keyless providers use the sentinel, otherwise look up stored key.
    const apiKey = effectiveApiKey(provider, getKey(provider));
    try {
      const modelIds = await discoverModels(def, apiKey === "no-key" ? undefined : apiKey);
      // Register each discovered model with the bridge so resolveModel() works.
      for (const id of modelIds) {
        registerCustomModel(provider, id);
      }
      res.json({ models: modelIds });
    } catch (e) {
      const msg = (e as Error).message;
      res.status(502).json({ error: `Model discovery failed for '${provider}': ${msg}` });
    }
  });

  return r;
}