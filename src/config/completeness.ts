// The configuration gate (Constitution VI).
// isConfigured() = >=2 candidates + judge set + a key for every referenced provider.
import type { RawConfig } from "./schema.js";
import { referencedProviders, loadSecrets } from "./secrets.js";
import { paths } from "../util/paths.js";

export interface CompletenessReport {
  configured: boolean;
  reasons: string[]; // empty when configured === true
}

/** Check whether the system is ready to fuse. Pure read; no side effects. */
export function isConfigured(config: RawConfig, secretsPath = paths.secrets(), keyPath = paths.masterKey()): CompletenessReport {
  const reasons: string[] = [];
  const candidates = config.candidates ?? [];
  if (candidates.length < 2) reasons.push(`need at least 2 candidates (have ${candidates.length})`);
  if (candidates.length > 5) reasons.push(`at most 5 candidates (have ${candidates.length})`);
  if (!config.judge) reasons.push("judge is not set");

  const referenced = referencedProviders(config);
  if (referenced.length === 0 && !config.judge) {
    // nothing to check keys for yet
  } else {
    const secrets = loadSecrets(secretsPath, keyPath);
    const missing = referenced.filter((p) => !secrets.providers[p]?.apiKey);
    if (missing.length > 0) reasons.push(`missing API key for provider(s): ${missing.join(", ")}`);
  }

  return { configured: reasons.length === 0, reasons };
}
