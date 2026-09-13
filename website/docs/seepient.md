---
title: OpenFusion + Seepient
---

<p class="of-eyebrow">Showcase</p>

# OpenFusion <em>+ Seepient</em>

**Seepient** ([seepient.zyntopia.com](https://seepient.zyntopia.com)) is our own agent — a
lightweight, local-first AI agent CLI from the same author as OpenFusion. It's the agent we
use to showcase OpenFusion, because the division of labor between the two is exactly what
fusion is built for: **Seepient does the legwork; OpenFusion brings the panel.**

This page covers setup (about five minutes if OpenFusion is already configured) and a
complete use-case walkthrough.

## Why this pairing

- **Same beliefs.** Seepient runs on your machine, uses your provider keys, and asks before
  acting — its consent modes range from ask-everything to fully autonomous.
- **Native MCP hosting.** Seepient's gateway connects MCP servers as first-class tool
  sources. OpenFusion plugs in without hacks or wrappers.
- **Same skill format.** Seepient reads `SKILL.md + references/` folders, so the OpenFusion
  agent skill works unmodified.

## 1 · Install Seepient

```bash
brew tap hashangit/seepient
brew install seepient
seepient setup        # one-time wizard: provider keys, model assignments
```

Full installation and configuration docs live at
[seepient.zyntopia.com](https://seepient.zyntopia.com).

## 2 · Register OpenFusion as a gateway target

Seepient's gateway is **enabled by default** and reads its targets from
`~/.seepient/gateway.json`. Add OpenFusion to the `targets` array:

```json
{
  "targets": [
    {
      "kind": "mcp",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "openfusion-mcp"],
      "description": "Fusion panel — fans a prompt out to several models and returns one judged answer",
      "tags": ["ai", "research", "review"],
      "enabled": true
    }
  ]
}
```

Then restart Seepient (or start a new session) so the gateway picks it up. If you've
disabled the gateway in settings, re-enable `gateway.enabled` and restart.

::: tip Building OpenFusion from source?
Point the target at your build instead — `"command": "node"` with
`"args": ["/absolute/path/to/OpenFusion/dist/index.js"]`.
:::

**Prefer the REPL?** The same registration works from inside a Seepient session:

```
/gateway add openfusion {"kind":"mcp","transport":"stdio","command":"npx","args":["-y","openfusion-mcp"],"description":"Fusion panel","tags":["ai"],"enabled":true}
```

Check that it landed:

```
/gateway list
```

You should see `openfusion (enabled, MCP/stdio)` with the discovered tools counted.
`/gateway toggle openfusion` disables it without removing it; `/gateway remove openfusion`
unregisters it. Seepient exposes the connection through its gateway tools
(`gateway_call_tool`, `gateway_route`, …) — the agent discovers and calls `fusion` through
them, with semantic routing picking fusion for questions that deserve a panel.

## 3 · Install the agent skill (recommended)

Seepient speaks the same skill format OpenFusion ships. Install it globally so every
workspace benefits:

```bash
mkdir -p ~/.seepient/skills/openfusion
cp -r "$(npm root -g)/openfusion-mcp/skill/"* ~/.seepient/skills/openfusion/
```

For a single project, copy into the project's `.agents/skills/openfusion/` instead. The
skill teaches Seepient the working method — gather context first, then call `fusion` once
with a prepared dossier.

## 4 · Verify

Start Seepient and hand it a fusion-worthy question:

```text
seepient
> Research how this worker processes jobs, then ask the fusion panel whether a
  queue or a streaming pull is the better fit. Include the code you found.
```

Seepient does the legwork, routes the prepared question to OpenFusion through the gateway,
and you'll see progress as each candidate answers and the judge synthesizes. The run lands
in the OpenFusion dashboard at `http://localhost:9077` like any other.

## Showcase: an architecture decision, end to end

This is the demo we run when we show the pairing. Scenario: *which cache invalidation
strategy should this service use?*

1. **The legwork — Seepient.** Ask it to research before answering. It reads the service,
   enumerates the read/write patterns, notes the consistency requirements, and drafts a
   dossier. All local, all with its own model — no fusion cost yet.

2. **The panel — OpenFusion.** Seepient calls `fusion` once, with the dossier as context.
   OpenFusion fans the prepared question out to your configured panel in parallel, drops
   candidates that stall, and the judge compares the survivors — consensus,
   contradictions, blind spots — before writing one answer.

3. **The receipt.** Open the dashboard: the fusion is logged with a row per sub-call, so
   you can see which model said what, what it cost, and how long it took.

The point the demo makes: the agent is responsible for *what to ask*; the panel is
responsible for *what the answer should be*. Neither duplicates the other.

---

<div class="of-next">

**Next up**

- [Using the fusion tool](/docs/using-fusion.html) — parameters, personas, async results
- [The dashboard](/docs/dashboard.html) — Playground and activity

</div>

<style>
.of-next {
  border-top: 1px solid var(--of-hairline);
  margin-top: 48px;
  padding-top: 20px;
  font-size: 14.5px;
  color: var(--of-mute);
}
.of-next ul {
  margin-top: 8px;
  padding-left: 18px;
}
.of-next li {
  margin: 6px 0;
}
</style>
