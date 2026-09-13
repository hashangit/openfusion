---
title: Connect your agent
---

<p class="of-eyebrow">Get started</p>

# Connect your <em>agent</em>

OpenFusion is a local MCP server, so it works with anything that speaks
[ MCP](https://modelcontextprotocol.io/) — Claude Code, Cursor, Cline, Zed, Codex, Gemini
CLI, and many more.

**The easy way:** run `npx openfusion-setup`. It detects your client, writes the right
config, and installs the agent skill. The snippets below are for doing it by hand.

::: tip Using Seepient — our own agent?
It has a dedicated guide with setup and a full showcase walkthrough:
[OpenFusion + Seepient](/docs/seepient.html).
:::

## The server command

For an npm install, the server entry is always the same two lines — what differs is where
each client wants to see them:

```json
{
  "command": "npx",
  "args": ["-y", "openfusion-mcp"]
}
```

If you built from source, use the path to your build instead:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/OpenFusion/dist/index.js"]
}
```

You can also set `OPENFUSION_HOME` in the server's `env` to choose where config, keys, and
the database live. Omit it to use the OS default — the active path prints on every startup.

## Client support matrix

| Client | Where it's configured | Auto-loads `.mcp.json`? | Skill? |
| --- | --- | :---: | :---: |
| Claude Code | `.mcp.json` or `claude mcp add` | ✓ | ✓ `.claude/skills/` |
| ZCode | `.mcp.json` | ✓ | ✓ `.zcode/skills/` |
| **Seepient** | `~/.seepient/gateway.json` or `/gateway add` | ✗ | ✓ `~/.seepient/skills/` |
| Cursor | `.cursor/mcp.json` | ✗ | rules `.mdc` |
| Cline / Roo Code | `cline_mcp_settings.json` | ✗ | `.clinerules` |
| Zed | `context_servers` in settings | ✗ | ✗ |
| Continue | `~/.continue/config.yaml` | ✗ | ✗ |
| Codex (OpenAI) | `codex mcp add` / `~/.codex/config.toml` | ✗ | ✗ |
| Gemini CLI / Qwen / Kimi | `~/.gemini/settings.json` (and siblings) | ✗ | ✗ |
| Antigravity | `mcp_config.json` | ✗ | ✓ `.agent/skills/` |
| opencode | `opencode.json` | ✗ | `AGENTS.md` |
| Hermes | `~/.hermes/config.yaml` | ✗ | ✗ |
| Claude Desktop | `claude_desktop_config.json` | ✗ | ✗ |
| Codebuff | `.codebuff/mcp.json` | ✗ | ✓ `.codebuff/skills/` |

::: info No native MCP client?
Aider has no native MCP support yet (feature requested). Pi and OpenClaw connect through
community adapters — follow the adapter's own README.
:::

## Per-client setup

### Claude Code

The simplest path: open your project in Claude Code and approve the `.mcp.json` it
auto-loads. To register globally instead:

```bash
claude mcp add openfusion -s user -- npx -y openfusion-mcp
```

### ZCode

Add to `~/.zcode/cli/config.json` under `mcp.servers`:

```json
{
  "mcp": {
    "servers": {
      "openfusion": {
        "command": "npx",
        "args": ["-y", "openfusion-mcp"]
      }
    }
  }
}
```

### Cursor

Create `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "openfusion": {
      "command": "npx",
      "args": ["-y", "openfusion-mcp"]
    }
  }
}
```

### Cline / Roo Code (VS Code)

Open the Cline sidebar → **MCP servers → Edit MCP settings**, which opens
`cline_mcp_settings.json`, and add:

```json
{
  "mcpServers": {
    "openfusion": {
      "command": "npx",
      "args": ["-y", "openfusion-mcp"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Zed

Add to `~/.config/zed/settings.json`. Note the key is `context_servers` and `command` is
an object:

```json
{
  "context_servers": {
    "openfusion": {
      "command": {
        "path": "npx",
        "args": ["-y", "openfusion-mcp"]
      }
    }
  }
}
```

### Seepient

Seepient hosts MCP servers through its **gateway** (enabled by default). Add OpenFusion to
the `targets` array in `~/.seepient/gateway.json` — the full walkthrough, including the
showcase use-case, is in [OpenFusion + Seepient](/docs/seepient.html):

```json
{
  "targets": [
    {
      "kind": "mcp",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "openfusion-mcp"],
      "description": "Fusion panel — many models, one judged answer",
      "tags": ["ai", "research"],
      "enabled": true
    }
  ]
}
```

Restart Seepient, verify with `/gateway list`, and install the skill into
`~/.seepient/skills/openfusion/`.

### Continue

Edit `~/.continue/config.yaml`:

```yaml
mcpServers:
  openfusion:
    command: npx
    args:
      - -y
      - openfusion-mcp
```

### Codex (OpenAI)

```bash
codex mcp add openfusion -- npx -y openfusion-mcp
```

Or edit `~/.codex/config.toml` — note it's `mcp_servers` with an underscore:

```toml
[mcp_servers.openfusion]
command = "npx"
args = ["-y", "openfusion-mcp"]
```

### Gemini CLI · Qwen Code · Kimi Code

All three are Gemini-CLI-family — same shape, different files (`~/.gemini/settings.json`,
`~/.qwen/settings.json`, `~/.kimi/settings.json`):

```json
{
  "mcpServers": {
    "openfusion": {
      "command": "npx",
      "args": ["-y", "openfusion-mcp"]
    }
  }
}
```

### Antigravity

Create `mcp_config.json` in the project root (or `.antigravity/mcp_config.json`):

```json
{
  "mcpServers": {
    "openfusion": {
      "command": "npx",
      "args": ["-y", "openfusion-mcp"]
    }
  }
}
```

### opencode

Create `opencode.json` in the project root. Note the distinct shape — `type`, `command`
as an array, `environment`:

```json
{
  "mcp": {
    "openfusion": {
      "type": "local",
      "command": ["npx", "-y", "openfusion-mcp"]
    }
  }
}
```

### Hermes

Edit `~/.hermes/config.yaml`:

```yaml
mcpServers:
  openfusion:
    command: npx
    args:
      - -y
      - openfusion-mcp
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "openfusion": {
      "command": "npx",
      "args": ["-y", "openfusion-mcp"]
    }
  }
}
```

### Codebuff

Create `.codebuff/mcp.json` in the project root:

```json
{
  "mcpServers": {
    "openfusion": {
      "command": "npx",
      "args": ["-y", "openfusion-mcp"]
    }
  }
}
```

## Install the agent skill (recommended)

The setup command installs the `openfusion` skill automatically where the client supports
it. The skill teaches your agent the working method: **do the legwork first — read, search,
reproduce — then bring a prepared dossier and call `fusion` once.** Without it, agents tend
to call fusion for everything, which wastes time and money.

If you'd rather install it by hand, copy the `skill/` folder into your client's skills
directory so it ends up as `openfusion/SKILL.md` plus `openfusion/references/`:

| Client | Skills path |
| --- | --- |
| Claude Code | `.claude/skills/openfusion/` |
| ZCode | `.zcode/skills/openfusion/` |
| Antigravity | `.agent/skills/openfusion/` |
| Codebuff | `.codebuff/skills/openfusion/` |

## Let your agent do it

If your client can edit files and run commands, paste this and it will wire everything up:

> Add the OpenFusion MCP server to your config. The server command is `npx -y
> openfusion-mcp`. Register it as `openfusion` in whatever MCP config this client reads,
> then tell me to restart so it loads. After that, confirm the `fusion` and
> `open_dashboard` tools are available.

## Verify

After restarting your client:

```
fusion({ prompt: "In one sentence, why fuse multiple LLMs?" })
```

A consolidated answer means you're done. An error pointing at `http://localhost:9077`
means the panel isn't configured yet — finish the dashboard setup in
[Installation](/docs/getting-started.html#_3-·-configure-models-and-keys).

---

<div class="of-next">

**Next up**

- [Configuration](/docs/configuration.html) — pick your panel and your judge
- [Using the fusion tool](/docs/using-fusion.html) — parameters, personas, async results

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
