# Installing OpenFusion in your MCP client

OpenFusion is a local MCP server. Once you've [built it](./README.md#install) (`node dist/index.js`), you point any MCP-capable client at it. This guide covers **18+ clients**.

> **TL;DR for Claude Code & ZCode:** they auto-load a project-root `.mcp.json`. This repo ships one — just open the repo in the client and approve. Everyone else: copy the snippet for your client below.

## Before you start

After building, OpenFusion needs a one-time configuration in the dashboard:

1. Start the server: `node dist/index.js` (or the always-on dashboard: `node dist/ui-only.js`)
2. Open **http://localhost:9077**
3. Add **2–5 candidate models** + a **judge** model + an **API key** for each provider you referenced. Use **Test** to validate each before saving.
4. The **● Configured** badge turns green — `fusion` now works.

The dashboard binds to `127.0.0.1` only; keys are AES-256-GCM encrypted at rest.

Throughout, replace:
- `/abs/path/to/OpenFusion/dist/index.js` → your actual build path
- `OPENFUSION_HOME` → where OpenFusion stores config/keys/db (default: `~/Library/Application Support/openfusion` on macOS, `~/.local/share/openfusion` on Linux)

---

## Client support matrix

| Client | Mechanism | Auto-loads `.mcp.json`? | Skill? |
|--------|-----------|:---:|:---:|
| **Claude Code** | `.mcp.json` + `claude mcp add` | ✅ | ✅ `.claude/skills/` |
| **ZCode** | `.mcp.json` | ✅ | ✅ `.zcode/skills/` |
| **Cursor** | `.cursor/mcp.json` | ❌ | rules `.mdc` |
| **Cline / Roo** | `cline_mcp_settings.json` | ❌ | `.clinerules` |
| **Zed** | `context_servers` in settings | ❌ | ❌ |
| **Continue** | `~/.continue/config.yaml` | ❌ | ❌ |
| **Codex (OpenAI)** | `codex mcp add` / `~/.codex/config.toml` | ❌ | ❌ |
| **Gemini CLI** | `~/.gemini/settings.json` | ❌ | ❌ |
| **Qwen Code** | `~/.qwen/settings.json` | ❌ | ❌ |
| **Kimi Code** | `~/.kimi/settings.json` | ❌ | ❌ |
| **Antigravity** | `mcp_config.json` | ❌ | ✅ `.agent/skills/` |
| **opencode** | `opencode.json` | ❌ | `AGENTS.md` |
| **Hermes** | `~/.hermes/config.yaml` | ❌ | ❌ |
| **Claude Desktop** | `claude_desktop_config.json` | ❌ | ❌ |
| **Codebuff** | `.codebuff/mcp.json` | ❌ | ✅ `.codebuff/skills/` |

> **Aider, Pi, OpenClaw:** Aider has no native MCP client (feature requested). Pi/OpenClaw MCP support is via community adapters — follow the adapter's README.

---

## Per-client setup

The base server entry is always:

```jsonc
{
  "command": "node",
  "args": ["/abs/path/to/OpenFusion/dist/index.js"],
  "env": { "OPENFUSION_HOME": "/abs/path/to/openfusion-data" }
}
```

### Claude Code (CLI) — `.mcp.json` (auto-loaded) or `claude mcp add`

This repo already ships a [`.mcp.json`](./.mcp.json); open the repo in Claude Code and approve it. Or register globally:

```bash
claude mcp add openfusion -s user -e OPENFUSION_HOME=/abs/path/to/openfusion-data -- node /abs/path/to/OpenFusion/dist/index.js
```
*Docs: https://docs.claude.com/en/docs/claude-code/mcp*

### ZCode — `.mcp.json` (auto-loaded)

Ships with this repo. Open the project in ZCode and approve. Or add to `~/.zcode/cli/config.json` under `mcp.servers`:

```jsonc
{
  "mcp": { "servers": { "openfusion": {
    "command": "node",
    "args": ["/abs/path/to/OpenFusion/dist/index.js"],
    "env": { "OPENFUSION_HOME": "/abs/path/to/openfusion-data" }
  } } }
}
```

### Cursor — `.cursor/mcp.json`

Create `/path/to/repo/.cursor/mcp.json` (or `~/.cursor/mcp.json` for global):

```jsonc
{ "mcpServers": { "openfusion": {
  "command": "node",
  "args": ["/abs/path/to/OpenFusion/dist/index.js"],
  "env": { "OPENFUSION_HOME": "/abs/path/to/openfusion-data" }
} } }
```
*Docs: https://docs.cursor.com/context/model-context-protocol*

### Cline / Roo Code (VS Code)

Open the Cline sidebar → **MCP servers → Edit MCP settings**, which opens `cline_mcp_settings.json`. Add:

```jsonc
{ "mcpServers": { "openfusion": {
  "command": "node",
  "args": ["/abs/path/to/OpenFusion/dist/index.js"],
  "env": { "OPENFUSION_HOME": "/abs/path/to/openfusion-data" },
  "disabled": false,
  "autoApprove": []
} } }
```
*Docs: https://docs.cline.bot/mcp*

### Zed

Add to `~/.config/zed/settings.json` (project or global). Note: key is `context_servers`, and `command` is an **object**:

```jsonc
{ "context_servers": { "openfusion": {
  "command": { "path": "node", "args": ["/abs/path/to/OpenFusion/dist/index.js"] },
  "env": { "OPENFUSION_HOME": "/abs/path/to/openfusion-data" }
} } }
```
*Docs: https://zed.dev/docs/context-servers*

### Continue

Edit `~/.continue/config.yaml`:

```yaml
mcpServers:
  openfusion:
    command: node
    args:
      - /abs/path/to/OpenFusion/dist/index.js
    env:
      OPENFUSION_HOME: /abs/path/to/openfusion-data
```
*Docs: https://docs.continue.dev/customize/deep-dives/mcp*

### Codex (OpenAI) — `codex mcp add` or `~/.codex/config.toml`

```bash
codex mcp add openfusion -e OPENFUSION_HOME=/abs/path/to/openfusion-data -- node /abs/path/to/OpenFusion/dist/index.js
```

Or edit `~/.codex/config.toml` (**`mcp_servers`** with an underscore — the dotted form silently fails):

```toml
[mcp_servers.openfusion]
command = "node"
args = ["/abs/path/to/OpenFusion/dist/index.js"]

[mcp_servers.openfusion.env]
OPENFUSION_HOME = "/abs/path/to/openfusion-data"
```

### Gemini CLI / Qwen Code / Kimi Code — `~/.gemini/settings.json` (Qwen: `~/.qwen/`, Kimi: `~/.kimi/`)

All three are Gemini-CLI-family; same `mcpServers` shape:

```jsonc
{ "mcpServers": { "openfusion": {
  "command": "node",
  "args": ["/abs/path/to/OpenFusion/dist/index.js"],
  "env": { "OPENFUSION_HOME": "/abs/path/to/openfusion-data" }
} } }
```
*Gemini: https://github.com/google-gemini/gemini-cli · Qwen: https://github.com/QwenLM/qwen-code · Kimi: https://github.com/MoonshotAI/kimi-cli*

### Antigravity — `mcp_config.json` (early)

Create `/path/to/repo/mcp_config.json` (or `.antigravity/mcp_config.json`):

```jsonc
{ "mcpServers": { "openfusion": {
  "command": "node",
  "args": ["/abs/path/to/OpenFusion/dist/index.js"],
  "env": { "OPENFUSION_HOME": "/abs/path/to/openfusion-data" }
} } }
```
*Docs: https://antigravity.dev/docs (MCP support is evolving — verify against the latest release)*

### opencode — `opencode.json`

Create `/path/to/repo/opencode.json`. Note the distinct shape (`type`, `command` array, `environment`):

```jsonc
{ "mcp": { "openfusion": {
  "type": "local",
  "command": ["node", "/abs/path/to/OpenFusion/dist/index.js"],
  "environment": { "OPENFUSION_HOME": "/abs/path/to/openfusion-data" }
} } }
```
*Docs: https://opencode.ai/docs/mcp-servers*

### Hermes — `~/.hermes/config.yaml`

```yaml
mcpServers:
  openfusion:
    command: node
    args:
      - /abs/path/to/OpenFusion/dist/index.js
    env:
      OPENFUSION_HOME: /abs/path/to/openfusion-data
```

### Claude Desktop — `claude_desktop_config.json`

macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```jsonc
{ "mcpServers": { "openfusion": {
  "command": "node",
  "args": ["/abs/path/to/OpenFusion/dist/index.js"],
  "env": { "OPENFUSION_HOME": "/abs/path/to/openfusion-data" }
} } }
```

### Codebuff — `.codebuff/mcp.json`

```jsonc
{ "mcpServers": { "openfusion": {
  "command": "node",
  "args": ["/abs/path/to/OpenFusion/dist/index.js"],
  "env": { "OPENFUSION_HOME": "/abs/path/to/openfusion-data" }
} } }
```

---

## Ask your agent to add it (copy-paste prompt)

If your client supports shell/file tools, paste this and let the agent do it (it'll fill in your real paths):

> Add the OpenFusion MCP server to your config. The server command is `node /abs/path/to/OpenFusion/dist/index.js` with env `OPENFUSION_HOME=/abs/path/to/openfusion-data`. Register it as `openfusion` in whatever MCP config this client reads, then tell me to restart so it loads. After that, confirm the `fusion` and `open_dashboard` tools are available.

---

## Install the OpenFusion skill (recommended)

The [`skill/SKILL.md`](./skill/SKILL.md) tells your agent **when to use Fusion** (complex reasoning, deep research, cross-model verification, high-stakes consensus) and **when not to** (routine coding, single-turn Q&A, trivial tasks). Drop it into your client's skills folder so the agent self-governs its Fusion usage.

| Client | Skills path |
|--------|-------------|
| Claude Code | `.claude/skills/openfusion/SKILL.md` |
| ZCode | `.zcode/skills/openfusion/SKILL.md` |
| Antigravity | `.agent/skills/openfusion/SKILL.md` |
| Codebuff | `.codebuff/skills/openfusion/SKILL.md` |

```bash
# Claude Code example:
mkdir -p ~/.claude/skills/openfusion
cp /abs/path/to/OpenFusion/skill/SKILL.md ~/.claude/skills/openfusion/SKILL.md
```

Or just ask your agent:

> Install the OpenFusion skill: copy `/abs/path/to/OpenFusion/skill/SKILL.md` into this client's skills folder as `openfusion/SKILL.md`.

## Verify

After restarting your client:

```
fusion({ prompt: "In one sentence, why fuse multiple LLMs?" })
```

You should get a consolidated answer. If it returns an error pointing to `http://localhost:9077`, OpenFusion isn't configured yet — finish the dashboard setup above.
