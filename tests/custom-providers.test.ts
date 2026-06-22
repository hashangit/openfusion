// Tests for custom provider registration and keyless provider handling.
import { describe, it, expect, beforeEach } from "vitest";
import {
  listProviders,
  listModels,
  resolveModel,
  registerCustomProviders,
  clearModelDescriptors,
  effectiveApiKey,
} from "../src/providers/pi-ai-bridge.js";
import {
  CUSTOM_PROVIDERS,
  RAPID_MLX,
  OLLAMA_CLOUD,
  KEYLESS_PROVIDERS,
  toModelDescriptor,
} from "../src/providers/custom-providers.js";

// Ensure custom providers are registered before each test.
beforeEach(() => {
  clearModelDescriptors();
  registerCustomProviders();
});

describe("custom providers: registration", () => {
  it("includes rapid-mlx and ollama-cloud in listProviders()", () => {
    const providers = listProviders();
    expect(providers).toContain("rapid-mlx");
    expect(providers).toContain("ollama-cloud");
    // Built-in providers should still be present.
    expect(providers).toContain("openai");
    expect(providers).toContain("anthropic");
  });

  it("does not duplicate providers already in pi-ai's registry", () => {
    const providers = listProviders();
    // Count occurrences of each built-in — should be exactly 1.
    const openaiCount = providers.filter((p) => p === "openai").length;
    expect(openaiCount).toBe(1);
  });
});

describe("custom providers: model listing", () => {
  it("lists rapid-mlx models", () => {
    const models = listModels("rapid-mlx");
    expect(models.length).toBe(RAPID_MLX.models.length);
    expect(models.map((m) => m.id)).toContain("mlx-community/Llama-3.2-3B-Instruct-4bit");
  });

  it("lists ollama-cloud models", () => {
    const models = listModels("ollama-cloud");
    expect(models.length).toBe(OLLAMA_CLOUD.models.length);
    expect(models.map((m) => m.id)).toContain("llama3.3");
  });

  it("still lists built-in provider models", () => {
    const models = listModels("openai");
    // OpenAI should still have models from pi-ai's registry.
    expect(models.length).toBeGreaterThan(0);
  });
});

describe("custom providers: model resolution", () => {
  it("resolves a rapid-mlx model descriptor", () => {
    const model = resolveModel("rapid-mlx", "mlx-community/Llama-3.2-3B-Instruct-4bit");
    expect(model.id).toBe("mlx-community/Llama-3.2-3B-Instruct-4bit");
    expect(model.provider).toBe("rapid-mlx");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("http://localhost:1234/v1");
  });

  it("resolves an ollama-cloud model descriptor", () => {
    const model = resolveModel("ollama-cloud", "llama3.3");
    expect(model.id).toBe("llama3.3");
    expect(model.provider).toBe("ollama-cloud");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("https://api.ollama.com/v1");
  });

  it("throws on unknown provider/model", () => {
    expect(() => resolveModel("nonexistent-provider", "fake-model")).toThrow();
  });
});

describe("custom providers: keyless handling", () => {
  it("KEYLESS_PROVIDERS contains rapid-mlx but not ollama-cloud", () => {
    expect(KEYLESS_PROVIDERS.has("rapid-mlx")).toBe(true);
    expect(KEYLESS_PROVIDERS.has("ollama-cloud")).toBe(false);
  });

  it("effectiveApiKey returns sentinel for keyless providers with no stored key", () => {
    const key = effectiveApiKey("rapid-mlx", undefined);
    expect(key).toBe("no-key");
  });

  it("effectiveApiKey returns sentinel for keyless providers with empty string", () => {
    const key = effectiveApiKey("rapid-mlx", "");
    expect(key).toBe("no-key");
  });

  it("effectiveApiKey returns stored key for keyless providers when present", () => {
    // If someone stored a key anyway, respect it.
    const key = effectiveApiKey("rapid-mlx", "my-custom-key");
    expect(key).toBe("my-custom-key");
  });

  it("effectiveApiKey returns stored key for normal providers", () => {
    const key = effectiveApiKey("openai", "sk-abc");
    expect(key).toBe("sk-abc");
  });

  it("effectiveApiKey returns empty string for normal providers with no key", () => {
    const key = effectiveApiKey("openai", undefined);
    expect(key).toBe("");
  });
});

describe("custom providers: completeness gate", () => {
  it("KEYLESS_PROVIDERS set can be used to filter missing-key providers", () => {
    const referenced = ["rapid-mlx", "openai"];
    const needsKey = referenced.filter((p) => !KEYLESS_PROVIDERS.has(p));
    // rapid-mlx is keyless, so only openai needs a key.
    expect(needsKey).toEqual(["openai"]);
  });
});

describe("custom providers: model descriptor shape", () => {
  it("toModelDescriptor produces correct shape for rapid-mlx", () => {
    const model = RAPID_MLX.models[0];
    const descriptor = toModelDescriptor(RAPID_MLX, model);
    expect(descriptor.id).toBe(model.id);
    expect(descriptor.name).toBe(model.name);
    expect(descriptor.api).toBe("openai-completions");
    expect(descriptor.provider).toBe("rapid-mlx");
    expect(descriptor.baseUrl).toBe("http://localhost:1234/v1");
    expect(descriptor.reasoning).toBe(model.reasoning);
    expect(descriptor.contextWindow).toBe(model.contextWindow);
    expect(descriptor.maxTokens).toBe(model.maxTokens);
  });

  it("toModelDescriptor includes compat overrides", () => {
    const model = RAPID_MLX.models[0];
    const descriptor = toModelDescriptor(RAPID_MLX, model);
    expect(descriptor.compat).toBeDefined();
    expect((descriptor.compat as Record<string, unknown>).maxTokensField).toBe("max_tokens");
  });
});