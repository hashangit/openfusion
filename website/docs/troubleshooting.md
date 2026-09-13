---
title: Troubleshooting & FAQ
---

<p class="of-eyebrow">Help</p>

# Troubleshooting & <em>FAQ</em>

## The fusion "failed", but it took a long time

**Likely cause:** your MCP client's tool-call timeout. A fusion with several candidates
plus a judge can take 30–90 seconds; some clients enforce a tighter ceiling (often 60s)
and report the call as failed even though the server kept going.

**Fix:** open the dashboard — the result is almost always there, complete, in the
[Playground history](/docs/dashboard.html#playground) or the Errors tab. For
clients with tight ceilings, use the
[deferred protocol](/docs/using-fusion.html#slow-clients-and-missing-results):
kick off, then retrieve with `_resume_from`.

## "Could not resolve model" on every candidate

**Likely cause:** a stale OpenFusion process from before an upgrade is still registered
with your client.

**Fix:** fully quit the MCP client, make sure no old `openfusion-mcp` / `node dist/index.js`
process survives, and restart. A running server won't pick up new code — restart it after
every update.

## The fusion tool refuses: "not configured"

The engine runs only when **2–5 candidates + a judge + a working key for every referenced
provider** are set. Open the dashboard and watch the **● Configured** badge — it turns
green when you're complete. Use **Test** on each key; a key that fails validation counts
as missing.

## Dashboard doesn't open

Start it manually:

```bash
openfusion-ui          # or: npx openfusion-ui
```

If the port is busy, an OpenFusion instance is probably already running — check
`http://localhost:9077` first.

## Installing fails on `better-sqlite3`

`better-sqlite3` compiles a native module. Most platforms fetch a prebuilt binary; when
the download fails, build it locally — Python 3 plus a C++ toolchain is required (Xcode
Command Line Tools on macOS, `build-essential` on Linux):

```bash
npm rebuild better-sqlite3
```

## Local models run out of memory (OOM)

When 3–5 local models (Ollama, llama.cpp, MLX) answer **in parallel**, smaller GPUs can
run out of VRAM. Switch the execution mode to **Sequential** in Settings → candidates then
answer one at a time. Also check your local server's own settings — e.g. Ollama's
`keep_alive` keeping models resident — since OpenFusion can't manage another server's VRAM.

## Where are my keys and config?

Everything lives under `OPENFUSION_HOME` — the path prints on every startup:

- macOS: `~/Library/Application Support/openfusion`
- Linux: `~/.local/share/openfusion`

Keys are in an encrypted `secrets.enc` file with a machine-bound `master.key`. Set
`OPENFUSION_HOME` (and restart the server) to keep separate profiles — two servers with
different homes see different configs.

## Does anything I write leave my machine?

Only the model calls themselves — from your machine directly to the providers you
configured, with your keys. OpenFusion's authors receive nothing: no telemetry, no
analytics, no prompts.

## Is fusion the same as just asking three models and picking one?

No. Nothing is "picked" — a **judge model** reads every answer, analyzes agreement and
blind spots, then **writes a new answer** from them. OpenRouter's research found most of
the quality lift lives in that synthesis step, which is why it's a deliberate second stage
rather than a vote.

## What does a fusion cost?

N+2 model calls per fusion: N candidates + two judge steps. The dashboard's per-model
charts show exactly where the money goes. A panel of cheap models, fused, often beats a
single frontier call on quality-per-dollar — that's the whole point.

## Something else?

- Check the **Errors tab** in the dashboard — failures are recorded with reasons.
- [Open an issue](https://github.com/hashangit/openfusion/issues) on GitHub.
