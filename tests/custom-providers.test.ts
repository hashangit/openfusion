// Tests for custom provider registration, discovery, and keyless provider handling.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  listProviders,
  listModels,
  resolveModel,
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
  discoverModels,
} from "../src/providers/custom-providers.js";
import { isConfigured } from "../src/config/completeness.js";
import { setProviderKey } from "../src/config/secrets.js";
import { RawConfigSchema, type RawConfig } from "../src/config/schema.js";
import { rmSync } from "node:fs";

// A secrets/key path that does not exist — loadSecrets() returns empty
// (unconfigured) without throwing, so we can assert the gate's key logic in
// isolation. Distinct per process to avoid cross-test bleed.
const NO_SECRETS = `/tmp/openfusion-test-secrets-${process.pid}.enc`;
const NO_KEY = `/tmp/openfusion-test-master-${process.pid}.key`;

/** Build a valid RawConfig from bare candidate/judge lists (settings defaulted). */
function cfg(candidates: Array<{ id: string; provider: string; model: string; enabled?: boolean }>, judges: Array<{ provider: string; model: string; enabled?: boolean }>): RawConfig {
  return RawConfigSchema.parse({ candidates, judges });
}

// Clear the model override registry before each test so registrations don't leak.
beforeEach(() => {
  clearModelDescriptors();
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

describe("custom providers: completeness gate with keyless providers", () => {
  // Constitution VI: a key is required for every referenced provider that needs
  // one. Keyless providers (rapid-mlx) are exempt; keyed providers (ollama-cloud)
  // are not. The >=2 candidates / >=1 judge rules are independent and untouched.

  it("is configured with only keyless providers referenced and no stored key", () => {
    const report = isConfigured(
      cfg(
        [
          { id: "c1", provider: "rapid-mlx", model: "mlx-community/Qwen3-35B", enabled: true },
          { id: "c2", provider: "rapid-mlx", model: "mlx-community/Qwen3-8B", enabled: true },
        ],
        [{ provider: "rapid-mlx", model: "mlx-community/Qwen3-35B", enabled: true }],
      ),
      NO_SECRETS,
      NO_KEY,
    );
    // No secrets file and no master key -> no stored keys, but rapid-mlx is
    // keyless so the gate must NOT report a missing key.
    expect(report.reasons).not.toContain("missing API key for provider(s): rapid-mlx");
    expect(report.configured).toBe(true);
  });

  it("is NOT configured when a keyed cloud provider (ollama-cloud) has no stored key", () => {
    const report = isConfigured(
      cfg(
        [
          { id: "c1", provider: "ollama-cloud", model: "gpt-oss:120b", enabled: true },
          { id: "c2", provider: "ollama-cloud", model: "gpt-oss:20b", enabled: true },
        ],
        [{ provider: "ollama-cloud", model: "gpt-oss:120b", enabled: true }],
      ),
      NO_SECRETS,
      NO_KEY,
    );
    // ollama-cloud is keyed and has no stored key -> gate must fail with a clear reason.
    expect(report.configured).toBe(false);
    expect(report.reasons.some((r) => r.includes("ollama-cloud"))).toBe(true);
  });

  it("is configured when a keyed cloud provider (ollama-cloud) HAS a stored key", () => {
    // Real positive direction: actually persist a key for a keyed provider via
    // the secrets store, then confirm the gate passes. Uses throwaway temp
    // paths and cleans up so it doesn't touch the user's real secrets.enc.
    const secrets = `/tmp/openfusion-test-secrets-keyed-${process.pid}.enc`;
    const keyPath = `/tmp/openfusion-test-master-keyed-${process.pid}.key`;
    try {
      setProviderKey("ollama-cloud", "test-key-abc", secrets, keyPath);
      const report = isConfigured(
        cfg(
          [
            { id: "c1", provider: "ollama-cloud", model: "gpt-oss:120b", enabled: true },
            { id: "c2", provider: "ollama-cloud", model: "gpt-oss:20b", enabled: true },
          ],
          [{ provider: "ollama-cloud", model: "gpt-oss:120b", enabled: true }],
        ),
        secrets,
        keyPath,
      );
      expect(report.configured).toBe(true);
    } finally {
      rmSync(secrets, { force: true });
      rmSync(keyPath, { force: true });
    }
  });
});

describe("custom providers: discoverModels", () => {
  // The only genuinely new runtime behavior in the feature: a live fetch to a
  // provider's /v1/models, then defensive parsing. Mock globalThis.fetch so the
  // suite never makes a real network call (CONTRIBUTING: no real API calls).
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(a) returns sorted model ids on a happy 200 response, with auth for a keyed provider", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model" }] }), { status: 200 }),
    );
    const ids = await discoverModels(OLLAMA_CLOUD, "my-key");
    expect(ids).toEqual(["a-model", "b-model"]);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ollama.com/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer my-key");
  });

  it("omits the Authorization header when no apiKey is supplied (keyless local provider)", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 }));
    await discoverModels(RAPID_MLX); // no apiKey
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("(b) returns [] when data is null", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ data: null }), { status: 200 }));
    expect(await discoverModels(OLLAMA_CLOUD)).toEqual([]);
  });

  it("(b) returns [] when data is missing entirely", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ object: "list" }), { status: 200 }));
    expect(await discoverModels(OLLAMA_CLOUD)).toEqual([]);
  });

  it("filters out non-object entries and entries whose id is not a string", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: "ok" }, null, { nope: 1 }, { id: 123 }, "raw-string" ] }),
        { status: 200 },
      ),
    );
    expect(await discoverModels(OLLAMA_CLOUD)).toEqual(["ok"]);
  });

  it("(c) throws with the status code on a non-200 response", async () => {
    fetchSpy.mockResolvedValue(new Response("unauthorized", { status: 401, statusText: "Unauthorized" }));
    await expect(discoverModels(OLLAMA_CLOUD, "bad-key")).rejects.toThrow(/401/);
  });

  it("(d) propagates a fetch rejection (e.g. an abort/timeout)", async () => {
    const abort = new Error("The operation was aborted");
    (abort as Error & { name: string }).name = "AbortError";
    fetchSpy.mockRejectedValue(abort);
    await expect(discoverModels(RAPID_MLX)).rejects.toThrow("The operation was aborted");
  });
});