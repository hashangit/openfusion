// The configuration gate (Constitution VI).
// isConfigured() = >=2 ENABLED candidates (<=5 unless benchmarkMode) +
// >=1 ENABLED judge + a key for every referenced provider.
import type { RawConfig } from "./schema.js";
import { referencedProviders, loadSecrets } from "./secrets.js";
import { paths } from "../util/paths.js";
import { KEYLESS_PROVIDERS } from "../providers/custom-providers.js";

export interface CompletenessReport {
  configured: boolean;
  reasons: string[]; // empty when configured === true
}

/** Check whether the system is ready to fuse. Pure read; no side effects. */
export function isConfigured(config: RawConfig, secretsPath = paths.secrets(), keyPath = paths.masterKey()): CompletenessReport {
  const reasons: string[] = [];
  const benchmark = config.settings.benchmarkMode === true;
  const enabledCandidates = (config.candidates ?? []).filter((c) => c.enabled !== false);
  const enabledJudges = (config.judges ?? []).filter((j) => j.enabled !== false);

  if (enabledCandidates.length < 2) {
    reasons.push(`need at least 2 enabled candidates (have ${enabledCandidates.length})`);
  }
  if (!benchmark && enabledCandidates.length > 5) {
    reasons.push(`at most 5 enabled candidates (have ${enabledCandidates.length}); enable Benchmark Mode to lift the cap`);
  }
  if (enabledJudges.length < 1) reasons.push("need at least 1 enabled judge");

  const referenced = referencedProviders(config);
  if (referenced.length > 0) {
    const secrets = loadSecrets(secretsPath, keyPath);
    // Keyless providers (e.g. rapid-mlx) don't need an API key stored in secrets.
    const needsKey = referenced.filter((p) => !KEYLESS_PROVIDERS.has(p));
    const missing = needsKey.filter((p) => !secrets.providers[p]?.apiKey);
    if (missing.length > 0) reasons.push(`missing API key for provider(s): ${missing.join(", ")}`);
  }

  return { configured: reasons.length === 0, reasons };
}
