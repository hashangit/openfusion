// Provider bridge over @earendil-works/pi-ai. Single source for all LLM calls.
// Injects apiKey per-call (pi-ai stores nothing).
import {
  getModel,
  getProviders,
  getModels,
  complete,
  type Context,
  type AssistantMessage,
  type Usage,
  type Api,
} from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { CUSTOM_PROVIDERS, KEYLESS_PROVIDERS, buildModelDescriptor } from "./custom-providers.js";

/**
 * Sentinel API key for providers that don't require authentication (e.g. rapid-mlx).
 * pi-ai's OpenAI completions provider throws if apiKey is falsy; this sentinel
 * satisfies the check while the local server ignores it.
 */
const NO_KEY_SENTINEL = "no-key";

/** The model shape used throughout OpenFusion (a pi-ai Model with a broad Api). */
export type AnyModel = Model<Api>;

/**
 * Override registry for model descriptors not in pi-ai's static registry —
 * e.g. dynamically-registered providers (faux providers in tests, or custom
 * OpenAI-compatible endpoints added at runtime). Keyed by `${provider}/${model}`.
 */
const modelOverrides = new Map<string, AnyModel>();

export function registerModelDescriptor(provider: string, model: string, descriptor: AnyModel): void {
  modelOverrides.set(`${provider}/${model}`, descriptor);
}

export function clearModelDescriptors(): void {
  modelOverrides.clear();
}

/** Resolve a pi-ai Model for a provider+model chosen at runtime. Throws on unknown. */
export function resolveModel(provider: string, model: string): AnyModel {
  const override = modelOverrides.get(`${provider}/${model}`);
  if (override) return override;
  // getModel is generically typed over literal model ids; for runtime resolution we cast.
  try {
    const m = getModel(provider as never, model as never) as AnyModel | undefined;
    if (m) return m;
    throw new Error(`getModel returned undefined for ${provider}/${model}`);
  } catch (e) {
    throw new BridgeError(
      "UNKNOWN_PROVIDER_OR_MODEL",
      `Unknown provider '${provider}' or model '${model}': ${(e as Error).message}`,
    );
  }
}

/** List provider ids (for the UI dropdowns). Includes pi-ai's built-in + custom providers. */
export function listProviders(): string[] {
  const builtIn = getProviders() as string[];
  const customIds = Object.keys(CUSTOM_PROVIDERS);
  // Custom providers that aren't already in pi-ai's registry (avoid duplicates).
  const added = customIds.filter((id) => !builtIn.includes(id));
  return [...builtIn, ...added];
}

/** List models for a provider (for the UI dropdowns). Built-in only; custom providers use discovery. */
export function listModels(provider: string) {
  // Built-in pi-ai provider — delegate to the static registry.
  // May throw if provider unknown — let callers wrap.
  const models = getModels(provider as never) as Array<{
    id: string;
    contextWindow?: number;
    reasoning?: boolean | string;
    cost?: { input?: number; output?: number };
  }>;
  return models.map((m) => ({
    id: m.id,
    contextWindow: m.contextWindow,
    reasoning: m.reasoning,
    cost: m.cost,
  }));
}

/**
 * Resolve the effective API key for a provider for the COMPLETION path. pi-ai's
 * openai-completions provider throws on a falsy apiKey, so keyless providers
 * (e.g. rapid-mlx) that have no stored key get a module-private sentinel — the
 * local server ignores it. Everyone else passes through their stored key.
 * If a keyless provider has a stored key (user explicitly saved one), respect it.
 *
 * NOTE: this sentinel is intentionally NOT exported and is never compared
 * against outside this module. Discovery (/v1/models) routes auth through
 * KEYLESS_PROVIDERS directly (see server/api/providers.ts) and sends no
 * Authorization header for keyless providers, so the two paths don't share the
 * magic string. Callers MUST treat the returned value as opaque and must never
 * compare it against literals or branch on its contents.
 */
export function effectiveApiKey(provider: string, storedKey: string | undefined): string {
  if (KEYLESS_PROVIDERS.has(provider) && !storedKey) return NO_KEY_SENTINEL;
  return storedKey ?? "";
}

/**
 * Register a model for a custom provider at runtime (e.g. after discovery or
 * when the user types a model ID). Also registers the descriptor with pi-ai
 * so resolveModel() works at fusion time.
 */
export function registerCustomModel(provider: string, modelId: string): void {
  const def = CUSTOM_PROVIDERS[provider];
  if (!def) return; // Not a custom provider — ignore (built-in providers use pi-ai's registry).
  const descriptor = buildModelDescriptor(def, modelId);
  registerModelDescriptor(provider, modelId, descriptor);
}

/** Run a single non-streaming completion. The single-shot worker + both judge steps use this. */
export async function runComplete(
  model: AnyModel,
  context: Context,
  apiKey: string,
): Promise<AssistantMessage> {
  return complete(model, context, { apiKey });
}

/** Extract the text from an AssistantMessage (concatenating text blocks). Returns "" if none. */
export function extractText(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Find the first toolCall block of a given name, or undefined. */
export function extractToolCall<T = Record<string, unknown>>(
  msg: AssistantMessage,
  name: string,
): { arguments: T } | undefined {
  for (const b of msg.content) {
    if (b.type === "toolCall" && b.name === name) {
      return { arguments: b.arguments as T };
    }
  }
  return undefined;
}

/** Total cost (USD) summed across a Usage object's cost subfields. */
export function totalCost(usage: Usage): number {
  const c = usage.cost;
  return (c.input ?? 0) + (c.output ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0);
}

/** Validate a provider+model+key with a tiny ping before the user commits it (FR-013). */
export async function testPing(
  provider: string,
  model: string,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; latencyMs: number; usage?: Pick<Usage, "input" | "output">; error?: string }> {
  const startedAt = Date.now();
  const race = async () => {
    const m = resolveModel(provider, model);
    const ctx: Context = {
      systemPrompt: "You are a connectivity test. Reply with exactly: OK",
      messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
    };
    const resp = await complete(m, ctx, { apiKey });
    return resp.usage;
  };
  try {
    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`ping timed out after ${timeoutMs}ms`)), timeoutMs),
    );
    const usage = await Promise.race([race(), timer]);
    return { ok: true, latencyMs: Date.now() - startedAt, usage: { input: usage.input, output: usage.output } };
  } catch (e) {
    const msg = (e as Error).message;
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: msg.includes("timed out") ? "timeout" : msg.toLowerCase().includes("auth") || msg.toLowerCase().includes("401") || msg.toLowerCase().includes("api key") ? "auth_failed" : "error",
    };
  }
}

export class BridgeError extends Error {
  readonly code: string;
  readonly retryable = false;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

/**
 * Register all custom provider models referenced in a config (candidates + judges).
 * This must be called at startup after loading the config so that resolveModel()
 * works for custom providers like rapid-mlx and ollama-cloud. Without this, a
 * fusion request fails because the models were never registered — they only get
 * registered when the UI calls /api/providers/:provider/models, which may not
 * have happened yet.
 *
 * Note: listProviders() already returns custom provider ids via CUSTOM_PROVIDERS,
 * so there is no separate "register providers" step — only models need registering.
 */
export function registerConfigModels(config: { candidates?: Array<{ provider: string; model: string }>; judges?: Array<{ provider: string; model: string }> }): void {
  // candidates/judges are optional in the param type for defensive robustness.
  // In practice loadConfig()'s zod schema (RawConfigSchema) always defaults
  // these to [], so the real startup path never passes undefined — but this is
  // a public export, so tolerate a partial/empty config without crashing.
  const entries = [...(config?.candidates ?? []), ...(config?.judges ?? [])];
  for (const { provider, model } of entries) {
    if (CUSTOM_PROVIDERS[provider] && model) {
      registerCustomModel(provider, model);
    }
  }
}