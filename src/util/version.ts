// Single source of truth for the package version, read from package.json.
// Used by the MCP server handshake, /api/status, /api/health, and the startup banner.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * Resolve the version from the nearest package.json.
 * - When run from `dist/` (published/compiled): dist/util/version.js -> ../../package.json
 * - When run via tsx from `src/`: src/util/version.ts -> ../../package.json
 * Both resolve to the project root package.json.
 */
function readVersion(): string {
  // Try the project-root package.json first (works for both src and dist layouts).
  for (const rel of ["../../package.json", "../../../package.json"]) {
    try {
      // fileURLToPath(import.meta.url) — works under both node and tsx.
      const here = dirname(fileURLToPath(import.meta.url));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = require(join(here, rel));
      if (pkg && typeof pkg.version === "string") return pkg.version;
    } catch {
      /* try next */
    }
  }
  return "0.0.0-unknown";
}

export const VERSION: string = readVersion();
