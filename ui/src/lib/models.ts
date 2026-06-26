// Shared UI helpers for provider model lists.
import type { ProviderModel } from "../api";

/**
 * Merge two model lists, deduplicating by id. First occurrence wins (entries
 * from `a` keep their richer shape — e.g. contextWindow — over a bare `{id}`
 * from discovered lists). Used by Candidates + Judge to combine discovered
 * models with the provider's loaded list.
 */
export function mergeModelLists(a: ProviderModel[], b: ProviderModel[]): ProviderModel[] {
  const seen = new Set<string>();
  const result: ProviderModel[] = [];
  for (const m of a) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      result.push(m);
    }
  }
  for (const m of b) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      result.push(m);
    }
  }
  return result;
}