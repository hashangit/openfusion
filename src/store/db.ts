// SQLite via better-sqlite3 (WAL mode). Activities + sub_calls.
// Migrations are idempotent and tracked in schema_migrations.
import { createRequire } from "node:module";
import type { Database as DatabaseType } from "better-sqlite3";

export type DB = DatabaseType;

// Load the native addon with a clear error if it's missing/broken — the default
// static import would throw an opaque MODULE_NOT_FOUND at module load.
const require = createRequire(import.meta.url);
type DatabaseCtor = new (path: string) => DatabaseType;
function loadBetterSqlite(): DatabaseCtor {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("better-sqlite3") as DatabaseCtor;
  } catch {
    console.error(
      "\nOpenFusion: the better-sqlite3 native addon failed to load.\n" +
        "This usually means it didn't compile during install.\n" +
        "Fix: run `npm rebuild better-sqlite3` (or `pnpm rebuild better-sqlite3`) in the OpenFusion directory.\n" +
        "Building from source requires Python 3 and a C++ toolchain (Xcode CLT on macOS, build-essential on Linux).\n",
    );
    process.exit(1);
  }
}
const Database = loadBetterSqlite();

/** Open (or create) the SQLite database with WAL + busy_timeout, and run migrations. */
export function openDatabase(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001_initial",
    sql: `
      CREATE TABLE IF NOT EXISTS activities (
        id                  TEXT PRIMARY KEY,
        created_at          TEXT NOT NULL,
        prompt_excerpt      TEXT,
        has_context         INTEGER NOT NULL DEFAULT 0,
        candidate_count     INTEGER NOT NULL,
        survivor_count      INTEGER NOT NULL,
        judge_provider      TEXT,
        judge_model         TEXT,
        total_input_tokens  INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost          REAL    NOT NULL DEFAULT 0,
        total_latency_ms    INTEGER NOT NULL DEFAULT 0,
        status              TEXT NOT NULL,
        error               TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_activities_created_at ON activities(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activities_status     ON activities(status);

      CREATE TABLE IF NOT EXISTS sub_calls (
        id            TEXT PRIMARY KEY,
        activity_id   TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        created_at    TEXT NOT NULL,
        role          TEXT NOT NULL,           -- worker | judge_analysis | judge_synthesis
        slot_id       TEXT,                    -- candidate slot id (workers only)
        provider      TEXT NOT NULL,
        model         TEXT NOT NULL,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost          REAL    NOT NULL DEFAULT 0,
        latency_ms    INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL,           -- ok | timeout | error
        error         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_subcalls_activity ON sub_calls(activity_id);
      CREATE INDEX IF NOT EXISTS idx_subcalls_model    ON sub_calls(model);
    `,
  },
  {
    id: "002_add_generated_text",
    sql: `
      ALTER TABLE sub_calls ADD COLUMN generated_text TEXT;
      ALTER TABLE sub_calls ADD COLUMN analysis_json   TEXT;
    `,
  },
  {
    id: "003_add_persona",
    sql: `
      ALTER TABLE activities ADD COLUMN persona TEXT;
    `,
  },
  {
    id: "004_add_persona_source",
    sql: `
      ALTER TABLE activities ADD COLUMN persona_source TEXT;
    `,
  },
];

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map((r) => r.id),
  );
  const insert = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec(m.sql);
    insert.run(m.id, new Date().toISOString());
  }
}
