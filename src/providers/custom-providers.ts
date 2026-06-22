// Custom provider definitions for OpenFusion.
//
// pi-ai's static registry covers cloud providers, but local/OpenAI-compatible
// endpoints (like rapid-mlx and ollama-cloud) aren't in that registry. This
// module defines them so they appear in the web config dropdowns and resolve
// correctly at fusion time.
//
// Each entry provides:
//   - provider id, display name, and description
//   - whether an API key is required (local servers often don't need one)
//   - a list of popular models with their model descriptors (baseUrl, api, etc.)
//
// At startup, registerCustomProviders() injects these into the pi-ai bridge
// so listProviders(), listModels(), and resolveModel() all work seamlessly.
import type { AnyModel } from "./pi-ai-bridge.js";

/** A model descriptor for a custom provider. */
export interface CustomModelDescriptor {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** A custom provider definition with its models. */
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
  /** Popular models available on this provider. */
  models: CustomModelDescriptor[];
  /** Compat overrides for the OpenAI completions API (auto-detected if not set). */
  compat?: Record<string, unknown>;
}

// ─── Provider definitions ────────────────────────────────────────────────────

/** rapid-mlx: local MLX inference server for Apple Silicon. No API key needed. */
export const RAPID_MLX: CustomProviderDefinition = {
  id: "rapid-mlx",
  name: "Rapid-MLX (Local)",
  description: "Local MLX inference server for Apple Silicon. Runs on localhost — no API key needed.",
  apiKeyRequired: false,
  baseUrl: "http://localhost:1234/v1",
  api: "openai-completions",
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens",
    supportsStrictMode: false,
    supportsLongCacheRetention: false,
  },
  models: [
    {
      id: "mlx-community/Llama-3.2-3B-Instruct-4bit",
      name: "Llama 3.2 3B Instruct (4-bit)",
      contextWindow: 131072,
      maxTokens: 4096,
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    {
      id: "mlx-community/Qwen2.5-7B-Instruct-4bit",
      name: "Qwen 2.5 7B Instruct (4-bit)",
      contextWindow: 131072,
      maxTokens: 8192,
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    {
      id: "mlx-community/Mistral-Nemo-Instruct-2407-4bit",
      name: "Mistral Nemo Instruct (4-bit)",
      contextWindow: 131072,
      maxTokens: 4096,
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    {
      id: "mlx-community/DeepSeek-R1-Distill-Llama-8B-4bit",
      name: "DeepSeek R1 Distill Llama 8B (4-bit)",
      contextWindow: 131072,
      maxTokens: 8192,
      reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
};

/** ollama-cloud: Ollama's cloud API service. Requires an API key. */
export const OLLAMA_CLOUD: CustomProviderDefinition = {
  id: "ollama-cloud",
  name: "Ollama Cloud",
  description: "Ollama's hosted cloud API. Requires an API key from ollama.com.",
  apiKeyRequired: true,
  baseUrl: "https://api.ollama.com/v1",
  api: "openai-completions",
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens",
    supportsStrictMode: false,
    supportsLongCacheRetention: false,
  },
  models: [
    {
      id: "llama3.3",
      name: "Llama 3.3 70B",
      contextWindow: 131072,
      maxTokens: 32768,
      reasoning: false,
      cost: { input: 0.3, output: 0.7, cacheRead: 0, cacheWrite: 0 },
    },
    {
      id: "llama3.1",
      name: "Llama 3.1 8B",
      contextWindow: 131072,
      maxTokens: 4096,
      reasoning: false,
      cost: { input: 0.05, output: 0.1, cacheRead: 0, cacheWrite: 0 },
    },
    {
      id: "mistral",
      name: "Mistral 7B",
      contextWindow: 32768,
      maxTokens: 4096,
      reasoning: false,
      cost: { input: 0.05, output: 0.1, cacheRead: 0, cacheWrite: 0 },
    },
    {
      id: "qwen2.5",
      name: "Qwen 2.5 14B",
      contextWindow: 131072,
      maxTokens: 8192,
      reasoning: false,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
    },
    {
      id: "deepseek-r1",
      name: "DeepSeek R1",
      contextWindow: 131072,
      maxTokens: 8192,
      reasoning: true,
      cost: { input: 0.3, output: 1.0, cacheRead: 0, cacheWrite: 0 },
    },
    {
      id: "gemma2",
      name: "Gemma 2 9B",
      contextWindow: 8192,
      maxTokens: 4096,
      reasoning: false,
      cost: { input: 0.05, output: 0.1, cacheRead: 0, cacheWrite: 0 },
    },
  ],
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

/** Convert a CustomProviderDefinition + model to a pi-ai AnyModel descriptor. */
export function toModelDescriptor(
  provider: CustomProviderDefinition,
  model: CustomModelDescriptor,
): AnyModel {
  return {
    id: model.id,
    name: model.name,
    api: provider.api,
    provider: provider.id,
    baseUrl: provider.baseUrl,
    reasoning: model.reasoning,
    input: ["text" as const],
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(provider.compat ? { compat: provider.compat } : {}),
  };
}