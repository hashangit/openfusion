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
    // Enrich with metadata from custom provider definitions.
    const enriched = providers.map((id) => {
      const custom = CUSTOM_PROVIDERS[id];
      return {
        id,
        name: custom?.name ?? id,
        description: custom?.description ?? undefined,
        keyless: KEYLESS_PROVIDERS.has(id),
        discoverable: custom?.discoverable ?? false,
        local: custom?.local ?? false,
      };
    });
    res.json({ providers: enriched });
  });

  // GET /api/providers/:provider/models — list models for any provider.
  // For built-in providers: returns the static registry.
  // For discoverable custom providers (both local and cloud): attempts live
  // discovery from the provider's /v1/models endpoint. If the provider is
  // unreachable (e.g. local server down), returns an empty list — the UI
  // will show a free-text input for local providers or an error for cloud providers.
  r.get("/:provider/models", async (req, res) => {
    const provider = req.params.provider;
    const customDef = CUSTOM_PROVIDERS[provider];

    if (customDef?.discoverable) {
      // Attempt live discovery from the provider's /v1/models endpoint.
      const apiKey = effectiveApiKey(provider, getKey(provider));
      try {
        const modelIds = await discoverModels(customDef, apiKey === "no-key" ? undefined : apiKey);
        // Register discovered models so resolveModel() works at fusion time.
        for (const id of modelIds) {
          registerCustomModel(provider, id);
        }
        res.json({ models: modelIds.map((id) => ({ id })) });
      } catch {
        // Provider unreachable or auth failed — return empty list.
        res.json({ models: [] });
      }
      return;
    }

    // Built-in pi-ai provider — delegate to the static registry.
    try {
      res.json({ models: listModels(provider) });
    } catch (e) {
      const err = new Error((e as Error).message);
      (err as Error & { code?: string }).code = "UNKNOWN_PROVIDER";
      throw err;
    }
  });

  // GET /api/providers/:provider/discover — explicit discover endpoint.
  // Only for local providers that may need a manual retry (e.g. after starting
  // a local server). Cloud providers don't need this — they're always reachable.
  r.get("/:provider/discover", async (req, res) => {
    const provider = req.params.provider;
    const def = CUSTOM_PROVIDERS[provider];
    if (!def || !def.discoverable || !def.local) {
      res.status(404).json({ error: `Provider '${provider}' does not support model discovery.` });
      return;
    }
    const apiKey = effectiveApiKey(provider, getKey(provider));
    try {
      const modelIds = await discoverModels(def, apiKey === "no-key" ? undefined : apiKey);
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