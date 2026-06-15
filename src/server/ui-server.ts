// UI server: Express on 127.0.0.1:9077. Serves the React dashboard + REST API.
// 127.0.0.1 ONLY (holds API keys — Constitution IV). Same-origin, no CORS.
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../store/db.js";
import { paths, ensureHome } from "../util/paths.js";
import type { DB } from "../store/db.js";
import { configRouter } from "./api/config.js";
import { secretsRouter } from "./api/secrets.js";
import { providersRouter } from "./api/providers.js";
import { testRouter } from "./api/test.js";
import { statsRouter } from "./api/stats.js";
import { activityRouter } from "./api/activity.js";

export interface UiServerOptions {
  db?: DB;
  port?: number;
}

export async function startUiServer(options: UiServerOptions = {}): Promise<{ app: Express; port: number }> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Uniform error envelope: { error: CODE, detail, issues? }
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err && typeof err === "object" && "code" in err) {
      const e = err as { code: string; message: string; issues?: unknown[] };
      res.status(400).json({ error: e.code, detail: e.message, ...(e.issues ? { issues: e.issues } : {}) });
      return;
    }
    res.status(400).json({ error: "BAD_REQUEST", detail: (err as Error)?.message ?? "invalid request" });
  });

  if (!options.db) ensureHome();
  const db = options.db ?? openDatabase(paths.db());

  app.use("/api/config", configRouter());
  app.use("/api/secrets", secretsRouter());
  app.use("/api/providers", providersRouter());
  app.use("/api/test", testRouter());
  app.use("/api/stats", statsRouter(db));
  app.use("/api/activity", activityRouter(db));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // Serve the built React UI (ui-dist) if present. SPA catch-all for client routing.
  // (Express 5 requires a named param instead of the "*" wildcard.)
  const uiDist = resolveUiDist();
  if (uiDist) {
    app.use(express.static(uiDist));
    app.get("/{*splat}", (_req, res) => res.sendFile(join(uiDist, "index.html")));
  }

  const envPort = Number(process.env.OPENFUSION_UI_PORT);
  const port = options.port ?? (Number.isFinite(envPort) ? envPort : 9077);
  await new Promise<void>((resolve) =>
    app.listen(port, "127.0.0.1", () => {
      console.error(`OpenFusion UI on http://localhost:${port}`);
      resolve();
    }),
  );
  return { app, port };
}

/** Resolve the built UI directory (ui-dist at the package root in prod, or ui/dist in dev). */
function resolveUiDist(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/server/ui-server.js -> ../../ui-dist
  const prodDir = join(here, "..", "..", "ui-dist");
  if (existsSync(join(prodDir, "index.html"))) return prodDir;
  // dev: ../../ui/dist
  const devDir = join(here, "..", "..", "ui", "dist");
  if (existsSync(join(devDir, "index.html"))) return devDir;
  return undefined;
}
