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

/** List provider ids (for the UI dropdowns). */
export function listProviders(): string[] {
  return getProviders() as string[];
}

/** List models for a provider (for the UI dropdowns). */
export function listModels(provider: string) {
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
