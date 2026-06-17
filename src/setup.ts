#!/usr/bin/env node
// openfusion-setup — interactive installer that generates the correct MCP-client
// config snippet for your client (preferring `npx -y openfusion-mcp`), writes it
// to the right file when safe, and reminds you to install the skill.
//
// Run: `npx openfusion-setup` (or `node dist/setup.js` from source).
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { VERSION } from "./util/version.js";

const NPM_CMD = "npx";
const NPM_ARGS = ["-y", "openfusion-mcp"];
// From-source fallback (when the user is running a local clone).
const LOCAL_BIN = "dist/index.js";

type Mode = "npx" | "local";

interface ClientSpec {
  key: string;
  name: string;
  /** Where the snippet goes, if we can write it safely. */
  configFile?: string;
  /** Build the server entry object for this client's JSON shape. */
  entry: (mode: Mode) => unknown;
  /** The JSON key/path the entry sits under, for printed instructions. */
  jqPath: string;
  /** Special-case: a shell command instead of JSON (e.g. `claude mcp add`). */
  shellCommand?: (mode: Mode) => string;
  skillsDir?: string;
}

const isMac = process.platform === "darwin";

function serverEntry(mode: Mode): { command: string; args: string[]; env?: Record<string, string> } {
  return mode === "npx"
    ? { command: NPM_CMD, args: NPM_ARGS }
    : { command: "node", args: [LOCAL_BIN] };
}

const CLIENTS: ClientSpec[] = [
  {
    key: "claude-code",
    name: "Claude Code",
    shellCommand: (m) =>
      m === "npx"
        ? `claude mcp add openfusion -s user -- npx -y openfusion-mcp`
        : `claude mcp add openfusion -s user -- node ${LOCAL_BIN}`,
    jqPath: "(via the claude CLI above)",
    skillsDir: join(homedir(), ".claude", "skills", "openfusion"),
    entry: () => ({}),
  },
  {
    key: "zcode",
    name: "ZCode",
    configFile: join(homedir(), ".zcode", "cli", "config.json"),
    entry: (m) => ({ mcp: { servers: { openfusion: serverEntry(m) } } }),
    jqPath: "mcp.servers.openfusion",
    skillsDir: join(homedir(), ".zcode", "skills", "openfusion"),
  },
  {
    key: "cursor",
    name: "Cursor",
    configFile: ".cursor/mcp.json",
    entry: (m) => ({ mcpServers: { openfusion: serverEntry(m) } }),
    jqPath: "mcpServers.openfusion",
  },
  {
    key: "cline",
    name: "Cline / Roo Code (VS Code)",
    configFile: isMac
      ? join(homedir(), "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json")
      : undefined,
    entry: (m) => ({ mcpServers: { openfusion: { ...serverEntry(m), disabled: false, autoApprove: [] } } }),
    jqPath: "mcpServers.openfusion",
  },
  {
    key: "zed",
    name: "Zed",
    configFile: join(homedir(), ".config/zed/settings.json"),
    entry: (m) => ({
      context_servers: {
        openfusion: {
          command: { path: serverEntry(m).command, args: serverEntry(m).args },
        },
      },
    }),
    jqPath: "context_servers.openfusion",
  },
  {
    key: "claude-desktop",
    name: "Claude Desktop",
    configFile: isMac
      ? join(homedir(), "Library/Application Support/Claude/claude_desktop_config.json")
      : undefined,
    entry: (m) => ({ mcpServers: { openfusion: serverEntry(m) } }),
    jqPath: "mcpServers.openfusion",
  },
  {
    key: "gemini-cli",
    name: "Gemini CLI / Qwen Code / Kimi Code",
    configFile: join(homedir(), ".gemini/settings.json"),
    entry: (m) => ({ mcpServers: { openfusion: serverEntry(m) } }),
    jqPath: "mcpServers.openfusion",
  },
  {
    key: "codex",
    name: "Codex (OpenAI)",
    configFile: join(homedir(), ".codex/config.toml"),
    entry: (m) => `(toml) [mcp_servers.openfusion]\ncommand = "${m === "npx" ? "npx" : "node"}"\nargs = ${JSON.stringify(m === "npx" ? ["-y", "openfusion-mcp"] : [LOCAL_BIN])}`,
    jqPath: "mcp_servers.openfusion",
  },
];

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  console.log(`\n  OpenFusion v${VERSION} — setup\n`);
  console.log("  Which MCP client are you using?\n");
  CLIENTS.forEach((c, i) => console.log(`    ${i + 1}. ${c.name}`));
  console.log("    (anything else: I'll print a generic snippet)\n");

  const choice = (await rl.question("  Number (or Enter for generic): ")).trim();
  const idx = Number(choice) - 1;
  const client = Number.isInteger(idx) && idx >= 0 && idx < CLIENTS.length ? CLIENTS[idx] : null;

  const modeQ = await rl.question("  Install via npm (npx) or from a local clone? [n]px / [l]ocal: ");
  const mode: Mode = modeQ.toLowerCase().startsWith("l") ? "local" : "npx";

  console.log("");
  if (!client) {
    console.log("  Generic MCP server entry (adapt to your client's config format):\n");
    console.log(JSON.stringify(serverEntry(mode), null, 2));
    console.log("\n  See https://github.com/hashangit/openfusion/blob/main/INSTALL.md for client-specific shapes.");
    await skillReminder(rl, null);
    rl.close();
    return;
  }

  // Shell-command clients (Claude Code).
  if (client.shellCommand) {
    console.log(`  Run this to register OpenFusion with ${client.name}:\n`);
    console.log(`    ${client.shellCommand(mode)}\n`);
    await skillReminder(rl, client.skillsDir ?? null);
    rl.close();
    return;
  }

  // JSON-config clients.
  const snippet = client.entry(mode);
  if (client.configFile) {
    const wrote = tryWriteJson(client.configFile, snippet);
    if (wrote) {
      console.log(`  ✓ Wrote the OpenFusion entry to ${client.configFile} (under ${client.jqPath}).`);
      console.log("    Back up any prior version if needed; existing keys were merged, not overwritten.");
    } else {
      console.log(`  Add this to ${client.configFile} under ${client.jqPath}:\n`);
      console.log(JSON.stringify(snippet, null, 2).replace(/^/gm, "    "));
    }
  } else {
    console.log(`  Add this to ${client.name}'s MCP config under ${client.jqPath}:\n`);
    console.log(JSON.stringify(snippet, null, 2).replace(/^/gm, "    "));
  }
  console.log("");
  await skillReminder(rl, client.skillsDir ?? null);
  rl.close();
}

/** Merge `snippet` into a JSON config file (shallow merge at each level), creating it if absent. */
function tryWriteJson(path: string, snippet: unknown): boolean {
  try {
    let root: Record<string, unknown> = {};
    if (existsSync(path)) {
      root = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    }
    const merged = deepMerge(root, snippet as Record<string, unknown>);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Recursively merge src into dst (src wins on leaf conflicts; arrays replaced). */
function deepMerge(dst: Record<string, unknown>, src: Record<string, unknown>): Record<string, unknown> {
  const out = { ...dst };
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function skillReminder(rl: { question: (q: string) => Promise<string> }, skillsDir: string | null): Promise<void> {
  const skillSrc = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..", "skill");
  console.log("  Skill: for the agent to use OpenFusion well, install the shipped skill.");
  if (skillsDir) {
    const ans = (await rl.question(`  Copy the skill folder to ${skillsDir} now? [y/N]: `)).trim().toLowerCase();
    if (ans === "y" && existsSync(skillSrc)) {
      try {
        mkdirSync(skillsDir, { recursive: true });
        cpSync(skillSrc, skillsDir, { recursive: true });
        console.log(`  ✓ Skill installed at ${skillsDir}`);
        return;
      } catch {
        console.log("  ✗ Couldn't copy automatically — see below.");
      }
    }
  }
  console.log(`    Manual: cp -r skill/* <your-client>/skills/openfusion/`);
  console.log("    (path depends on the client — see INSTALL.md)\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
