# Contract: Config & Secrets File Schema

**Interface type**: Filesystem files in `~/.openfusion/` (resolved via `env-paths`). Owned by the OpenFusion server; read/written by the config layer (`src/config/`) and the dashboard via the REST API.

See [`data-model.md`](../data-model.md) E1/E2 for the entity description; this document is the authoritative on-disk schema.

---

## File: `~/.openfusion/config.json`  *(plaintext — model choices only, NO secrets)*

```jsonc
{
  "version": 1,
  "candidates": [
    { "id": "c1", "provider": "openai",    "model": "gpt-4o-mini" },
    { "id": "c2", "provider": "openrouter", "model": "anthropic/claude-3.5-sonnet" }
    // ... 2 to 5 entries
  ],
  "judge": { "provider": "anthropic", "model": "claude-3-5-sonnet-latest" },
  "settings": {
    "workerTimeoutMs": 120000,
    "uiPort": 9077,
    "bind": "127.0.0.1"
  }
}
```

**Rules**:
- `version` is server-managed; do not edit by hand. Current: `1`.
- `candidates` length must be **2–5**.
- Every `provider` (in `candidates[]` and `judge`) must exist in pi-ai `getProviders()`.
- Every `model` must exist in pi-ai `getModels(provider)`.
- `settings.workerTimeoutMs` ∈ [5_000, 600_000].
- `settings.bind` must be a loopback address.
- Written atomically (temp file → rename) with a `.bak` of the previous version.
- Missing file ⇒ treated as unconfigured (not an error).

---

## File: `~/.openfusion/secrets.enc`  *(binary — AES-256-GCM encrypted)*

**Layout**: `iv(12 bytes) | authTag(16 bytes) | ciphertext`.

The decrypted plaintext is JSON of shape:

```jsonc
{
  "providers": {
    "openai":     { "apiKey": "sk-..." },
    "anthropic":  { "apiKey": "sk-ant-..." },
    "openrouter": { "apiKey": "sk-or-..." }
  }
}
```

**Rules**:
- One key per provider, shared across every candidate slot + the judge that reference it.
- Encrypted with `master.key` (AES-256-GCM). See [`research.md` D4](../research.md).
- Never logged; never returned unmasked by any API.
- Missing file ⇒ treated as no keys configured.

---

## File: `~/.openfusion/master.key`  *(32 random bytes, `chmod 600`)*

- Generated on first run via `crypto.randomBytes(32)`.
- Machine-bound (not portable across machines — by design; a copied `secrets.enc` won't decrypt elsewhere without this key).
- `chmod 600`. If it's missing or unreadable, the server treats secrets as unconfigured and refuses fusions until the user re-enters keys (it does **not** silently regenerate a key, which would orphan existing secrets).

---

## File: `~/.openfusion/openfusion.db`  *(SQLite — WAL mode)*

Defined fully in [`data-model.md`](../data-model.md) E3/E4. Mentioned here only because it shares the `~/.openfusion/` directory. Created lazily on first fusion; migrations run on startup. Auxiliary `-wal` and `-shm` files are normal for WAL mode.

---

## `isConfigured()`  *(the gate — Constitution VI)*

```
isConfigured =
  config.candidates.length >= 2 AND
  config.candidates.length <= 5 AND
  config.judge is set AND
  every p in referencedProviders(config) has an entry in secrets.providers[p].apiKey
```

Where `referencedProviders(config)` = unique `provider` values across `candidates[]` and `judge`.

When `isConfigured()` is false, the `fusion` tool returns `isError: true` directing the user to `http://localhost:9077` (see [`mcp-fusion-tool.md`](./mcp-fusion-tool.md)).

---

## Migration story (v1 → future)

`config.version` lets future versions migrate the file on load. For v1 there is no migration code yet; a `migrate(oldConfig) → newConfig` function will be the single extension point when the schema changes. `secrets.enc` carries no version (its shape is stable); if the encryption envelope ever changes, a new filename (`secrets2.enc`) avoids clobbering.
