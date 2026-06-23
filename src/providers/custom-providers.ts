// Custom provider definitions for OpenFusion.
//
// pi-ai's static registry covers the well-known cloud providers, but two
// OpenAI-compatible endpoints aren't in it: rapid-mlx (a LOCAL MLX inference
// server on Apple Silicon) and ollama-cloud (Ollama's hosted CLOUD API). This
// module defines both so they appear in the web config dropdowns and resolve
// correctly at fusion time. Despite the branch name ("local-providers"), this
// feature intentionally covers BOTH a local server and a cloud provider.
//
// Both custom providers are discoverable — they expose a /v1/models endpoint
// so the server can fetch the actual available models at runtime. No hardcoded
// model lists: rapid-mlx's models depend on what's loaded locally, and
// ollama-cloud's catalog changes as Ollama adds new cloud models.
//
// The `local` flag distinguishes local servers (may be unreachable, so the UI
// shows a free-text input + a Discover button to retry) from cloud providers
// (always reachable, show a normal dropdown).
//
// KNOWN LIMITATION: buildModelDescriptor() bakes in default contextWindow
// (131072) and maxTokens (8192) for every discovered/typed model, because the
// OpenAI /v1/models response doesn't carry those fields. Cost is reported as 0
// for the same reason. If a provider under-reports, the dashboard's per-model
// context badge may be inaccurate; this does not affect fusion correctness.
//
// At runtime, registerConfigModels() (called at startup + after each config
// save) registers descriptors for models referenced in the saved config so
// resolveModel() works. For discovered or user-typed models,
// registerCustomModel() is called on the fly.
import type { AnyModel } from "./pi-ai-bridge.js";

/** A custom provider definition. */
export interface CustomProviderDefinition {
  /** Unique provider id (used in config.json and secrets). */
  id: string;
  /** Human-readable name for the UI. */
  name: string;
  /** Short description shown in the UI. */
  description: string;
  /** Whether this provider requires an API key. Local servers typically don't. */
  apiKeyRequired: boolean;
  /** Base URL for the OpenAI-compatible API endpoint. */
  baseUrl: string;
  /** pi-ai API type. All custom providers currently use openai-completions. */
  api: "openai-completions" | "openai-responses";
  /**
   * Whether this provider supports /v1/models discovery.
   * When true, the /models API endpoint will query the provider's /v1/models
   * for a live model list and return it as a normal dropdown.
   */
  discoverable: boolean;
  /**
   * Whether this is a local provider that may be unreachable.
   * When true + discoverable, the UI shows a free-text input for model IDs
   * if the server is down (no models found), plus a Discover button to retry.
   * Cloud providers (local=false) always show a normal dropdown.
   */
  local: boolean;
  /** Compat overrides for the OpenAI completions API (auto-detected if not set). */
  compat?: Record<string, unknown>;
}

// ─── Provider definitions ────────────────────────────────────────────────────

/** rapid-mlx: local MLX inference server for Apple Silicon. No API key needed. */
export const RAPID_MLX: CustomProviderDefinition = {
  id: "rapid-mlx",
  name: "Rapid-MLX (Local)",
  description:
    "Local MLX inference server for Apple Silicon. Runs on localhost — no API key needed. " +
    "Click Discover to load available models, or type a model ID directly.",
  apiKeyRequired: false,
  baseUrl: "http://localhost:8000/v1",
  api: "openai-completions",
  discoverable: true,
  local: true,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens",
    supportsStrictMode: false,
    supportsLongCacheRetention: false,
  },
};

/** ollama-cloud: Ollama's cloud API at ollama.com. Requires an API key. */
export const OLLAMA_CLOUD: CustomProviderDefinition = {
  id: "ollama-cloud",
  name: "Ollama Cloud",
  description:
    "Ollama's hosted cloud API at ollama.com. Requires an API key. " +
    "Models are fetched from the cloud catalog automatically.",
  apiKeyRequired: true,
  baseUrl: "https://ollama.com/v1",
  api: "openai-completions",
  discoverable: true,
  local: false,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens",
    supportsStrictMode: false,
    supportsLongCacheRetention: false,
  },
};

/** All custom provider definitions, keyed by provider id. */
export const CUSTOM_PROVIDERS: Record<string, CustomProviderDefinition> = {
  [RAPID_MLX.id]: RAPID_MLX,
  [OLLAMA_CLOUD.id]: OLLAMA_CLOUD,
};

/** Provider ids that don't require an API key. */
export const KEYLESS_PROVIDERS = new Set(
  Object.values(CUSTOM_PROVIDERS)
    .filter((p) => !p.apiKeyRequired)
    .map((p) => p.id),
);

/**
 * Build a model descriptor for a dynamically discovered or user-typed model.
 * Used by registerCustomModel() and the discover endpoint.
 */
export function buildModelDescriptor(
  provider: CustomProviderDefinition,
  modelId: string,
  overrides?: { contextWindow?: number; maxTokens?: number; reasoning?: boolean },
): AnyModel {
  return {
    id: modelId,
    name: modelId,
    api: provider.api,
    provider: provider.id,
    baseUrl: provider.baseUrl,
    reasoning: overrides?.reasoning ?? false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides?.contextWindow ?? 131072,
    maxTokens: overrides?.maxTokens ?? 8192,
    ...(provider.compat ? { compat: provider.compat } : {}),
  };
}

/** Response shape from the OpenAI-compatible /v1/models endpoint. */
export interface DiscoveryModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

export interface DiscoveryResponse {
  object?: string;
  data: DiscoveryModel[];
}

/**
 * Discover models from a provider's /v1/models endpoint.
 * Returns a list of model IDs, or throws on network/auth errors.
 */
export async function discoverModels(
  provider: CustomProviderDefinition,
  apiKey?: string,
): Promise<string[]> {
  const url = `${provider.baseUrl}/models`;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`${resp.status} ${resp.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  // Tolerate non-compliant /v1/models responses: a null body, a missing data
  // array, or non-object elements would otherwise crash discovery. Keep only
  // entries that look like { id: string }.
  const json = (await resp.json()) as DiscoveryResponse | null;
  const models = json && Array.isArray(json.data) ? json.data : [];
  return models
    .filter((m): m is DiscoveryModel => m != null && typeof m === "object" && typeof m.id === "string")
    .map((m) => m.id)
    .sort();
}