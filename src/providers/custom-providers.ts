// Custom provider definitions for OpenFusion.
//
// pi-ai's static registry covers cloud providers, but local/OpenAI-compatible
// endpoints (like rapid-mlx and ollama-cloud) aren't in that registry. This
// module defines them so they appear in the web config dropdowns and resolve
// correctly at fusion time.
//
// Custom providers are *discoverable*: they support the /v1/models endpoint
// so the UI can fetch the actual available models at runtime instead of relying
// on a hardcoded list that quickly goes stale. When discovery fails (server
// down, no network), the user can type a model ID directly.
//
// At startup, registerCustomProviders() injects these into the pi-ai bridge
// so resolveModel() works for any model the user selects. listProviders() and
// listModels() are also augmented to include these providers.
import type { AnyModel } from "./pi-ai-bridge.js";

/** A custom provider definition. Models are discovered at runtime via /v1/models. */
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
   * When true, the UI will offer a "Discover models" button that fetches the
   * model list at runtime; the user can also type a model ID directly.
   */
  discoverable: boolean;
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
    "Models depend on what you have loaded; click Discover or type a model ID.",
  apiKeyRequired: false,
  baseUrl: "http://localhost:8000/v1",
  api: "openai-completions",
  discoverable: true,
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
    "Cloud models (e.g. gpt-oss:120b-cloud) are discovered at runtime.",
  apiKeyRequired: true,
  baseUrl: "https://ollama.com/v1",
  api: "openai-completions",
  discoverable: true,
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
 * Build a model descriptor for a dynamically discovered model.
 * Used when the user selects a discovered model or types a custom model ID.
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
  const json = (await resp.json()) as DiscoveryResponse;
  const models = Array.isArray(json.data) ? json.data : [];
  return models.map((m) => m.id).sort();
}