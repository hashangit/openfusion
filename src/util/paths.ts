// OS-conventional paths for OpenFusion's local data (config, secrets, db).
// Overridable via OPENFUSION_HOME for tests / portable installs.
import envPaths from "env-paths";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const envApp = envPaths("openfusion", { suffix: "" });

/**
 * Resolve the OpenFusion home directory.
 * Precedence: OPENFUSION_HOME env > env-paths data dir > ~/.openfusion fallback.
 */
export function openfusionHome(): string {
  const fromEnv = process.env.OPENFUSION_HOME;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return envApp.data || join(homedir(), ".openfusion");
}

/** Ensure the home dir exists; returns its absolute path. */
export function ensureHome(): string {
  const dir = openfusionHome();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const paths = {
  home: openfusionHome,
  config: () => join(openfusionHome(), "config.json"),
  secrets: () => join(openfusionHome(), "secrets.enc"),
  masterKey: () => join(openfusionHome(), "master.key"),
  db: () => join(openfusionHome(), "openfusion.db"),
};
