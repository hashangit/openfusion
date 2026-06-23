// Tests for custom provider registration, discovery, and keyless provider handling.
import { describe, it, expect, beforeEach } from "vitest";
import {
  listProviders,
  listModels,
  resolveModel,
  registerCustomProviders,
  clearModelDescriptors,
  registerCustomModel,
  registerConfigModels,
  effectiveApiKey,
} from "../src/providers/pi-ai-bridge.js";
import {
  CUSTOM_PROVIDERS,
  RAPID_MLX,
  OLLAMA_CLOUD,
  KEYLESS_PROVIDERS,
  buildModelDescriptor,
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
    const openaiCount = providers.filter((p) => p === "openai").length;
    expect(openaiCount).toBe(1);
  });
});

describe("custom providers: model listing", () => {
  it("returns empty model list for discoverable custom providers", () => {
    const models = listModels("rapid-mlx");
    expect(models).toEqual([]);
  });

  it("returns empty model list for ollama-cloud (discoverable)", () => {
    const models = listModels("ollama-cloud");
    expect(models).toEqual([]);
  });

  it("still lists built-in provider models", () => {
    const models = listModels("openai");
    expect(models.length).toBeGreaterThan(0);
  });
});

describe("custom providers: dynamic model registration", () => {
  it("resolves a dynamically registered rapid-mlx model", () => {
    registerCustomModel("rapid-mlx", "mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit");
    const model = resolveModel("rapid-mlx", "mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit");
    expect(model.id).toBe("mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit");
    expect(model.provider).toBe("rapid-mlx");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("http://localhost:8000/v1");
  });

  it("resolves a dynamically registered ollama-cloud model", () => {
    registerCustomModel("ollama-cloud", "gpt-oss:120b-cloud");
    const model = resolveModel("ollama-cloud", "gpt-oss:120b-cloud");
    expect(model.id).toBe("gpt-oss:120b-cloud");
    expect(model.provider).toBe("ollama-cloud");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("https://ollama.com/v1");
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

describe("custom providers: definition shape", () => {
  it("RAPID_MLX has correct base URL (port 8000)", () => {
    expect(RAPID_MLX.baseUrl).toBe("http://localhost:8000/v1");
  });

  it("OLLAMA_CLOUD has correct base URL (ollama.com)", () => {
    expect(OLLAMA_CLOUD.baseUrl).toBe("https://ollama.com/v1");
  });

  it("both providers are discoverable", () => {
    expect(RAPID_MLX.discoverable).toBe(true);
    expect(OLLAMA_CLOUD.discoverable).toBe(true);
  });

  it("rapid-mlx is local, ollama-cloud is not", () => {
    expect(RAPID_MLX.local).toBe(true);
    expect(OLLAMA_CLOUD.local).toBe(false);
  });

  it("rapid-mlx is keyless", () => {
    expect(RAPID_MLX.apiKeyRequired).toBe(false);
  });

  it("ollama-cloud requires a key", () => {
    expect(OLLAMA_CLOUD.apiKeyRequired).toBe(true);
  });

  it("buildModelDescriptor produces correct shape for a rapid-mlx model", () => {
    const descriptor = buildModelDescriptor(RAPID_MLX, "my-model");
    expect(descriptor.id).toBe("my-model");
    expect(descriptor.name).toBe("my-model");
    expect(descriptor.api).toBe("openai-completions");
    expect(descriptor.provider).toBe("rapid-mlx");
    expect(descriptor.baseUrl).toBe("http://localhost:8000/v1");
    expect(descriptor.compat).toBeDefined();
    expect((descriptor.compat as Record<string, unknown>).maxTokensField).toBe("max_tokens");
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

describe("custom providers: registerConfigModels", () => {
  // registerConfigModels is imported with registerCustomProviders above.
  // It must be called AFTER registerCustomProviders (which is done in beforeEach).

  it("registers custom provider models from config so resolveModel works", () => {
    registerConfigModels({
      candidates: [
        { id: "c1", provider: "rapid-mlx", model: "mlx-community/Qwen3-35B-A3B-OptiQ-4bit", enabled: true },
        { id: "c2", provider: "ollama-cloud", model: "gpt-oss:120b-cloud", enabled: true },
        { id: "c3", provider: "openai", model: "gpt-4o", enabled: true },
      ],
      judges: [
        { provider: "rapid-mlx", model: "mlx-community/Qwen3-35B-A3B-OptiQ-4bit", enabled: true },
      ],
    });
    // rapid-mlx model should now resolve.
    const rapidModel = resolveModel("rapid-mlx", "mlx-community/Qwen3-35B-A3B-OptiQ-4bit");
    expect(rapidModel.provider).toBe("rapid-mlx");
    expect(rapidModel.baseUrl).toBe("http://localhost:8000/v1");

    // ollama-cloud model should now resolve.
    const ollamaModel = resolveModel("ollama-cloud", "gpt-oss:120b-cloud");
    expect(ollamaModel.provider).toBe("ollama-cloud");
    expect(ollamaModel.baseUrl).toBe("https://ollama.com/v1");

    // Built-in provider model should still work (not affected by registerConfigModels).
    const openaiModel = resolveModel("openai", "gpt-4o");
    expect(openaiModel.provider).toBe("openai");
  });

  it("skips entries with empty model strings", () => {
    clearModelDescriptors();
    registerCustomProviders();
    registerConfigModels({
      candidates: [
        { id: "c1", provider: "rapid-mlx", model: "", enabled: true },
      ],
      judges: [],
    });
    // Should not throw; empty model is simply skipped.
    expect(() => resolveModel("rapid-mlx", "")).toThrow();
  });

  it("skips providers that are not custom", () => {
    clearModelDescriptors();
    registerCustomProviders();
    // openai is a built-in provider, not a custom one — registerConfigModels should skip it.
    registerConfigModels({
      candidates: [
        { id: "c1", provider: "openai", model: "gpt-4o", enabled: true },
      ],
      judges: [],
    });
    // gpt-4o resolves via pi-ai's built-in registry, not via modelOverrides.
    const model = resolveModel("openai", "gpt-4o");
    expect(model.provider).toBe("openai");
  });
});