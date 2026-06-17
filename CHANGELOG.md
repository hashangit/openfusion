# Changelog

All notable changes to OpenFusion are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-06-16

### Added
- **On/off toggles** for candidates and judges — configure many, enable the ones you want to fuse with. Candidates enforce 2–5 enabled (min/max); judges enforce exactly 1 enabled.
- **Benchmark Mode** (Candidates page, default off) — lifts the max-candidate limit and forces a 10-minute candidate timeout, for comparing many models at once.
- **Error Log tab** — a dedicated troubleshooting view listing failed/partial fusions with a one-click **copy** button per activity (copies the full activity JSON incl. sub_calls + error).
- **Config schema v2** with automatic v1→v2 migration on load (single `judge` → `judges[]`; candidates gain `enabled`; settings gain `benchmarkMode`).

### Fixed
- **Judge latency was always 0** — both judge steps (analysis, synthesis) now record real wall-clock latency (incl. retry time) in the dashboard's per-step breakdown.

### Changed
- `judge` (single object) is now `judges` (list); each judge has an `enabled` flag. Only the first enabled judge runs.
- Disabled candidates/judges no longer require API keys (the API Keys page only shows providers used by enabled slots).
- Candidates enforce their 2–5 range on **enabled** slots (not total); benchmark mode lifts the 5 cap.

## [0.1.0] - 2026-06-16

### Changed
- **Per-call timeout default raised from 2 min to 5 min** (`settings.workerTimeoutMs`), giving slower providers more room. Still user-configurable (5 s – 10 min); lower it if your MCP client enforces a tighter tool-call ceiling.
- **Retry on failure** — workers and both judge steps now retry up to 3 times on a transient error or timeout (the per-call timeout resets on each attempt; exponential backoff between attempts). Previously a single timeout/error ended the call.

### Fixed
- The two judge steps (analysis + synthesis) now have a per-call timeout + retry, matching the workers. Previously a hung judge would hang the whole fusion indefinitely.

## [0.1.0] - 2026-06-16

The first public release. A local MCP server that brings OpenRouter's [Fusion](https://openrouter.ai/blog/announcements/fusion-beats-frontier/) panel architecture to any MCP-capable client — fan a prompt out to 2–5 candidate models, run a two-step judge, return one consolidated answer.

### Added
- **`fusion` MCP tool** — parallel fan-out to 2–5 single-shot candidates (`Promise.allSettled` + per-candidate timeout), a two-step judge (structured `record_analysis` tool call → synthesis) on the same provider/model, ≥2-survivor threshold, and progress notifications. OpenFusion is a fusion engine, not an agent — candidates get no tools; the caller supplies `prompt` + optional `context`.
- **`open_dashboard` MCP tool** — opens the config/stats dashboard in a browser.
- **Configuration system** — plaintext `config.json` (model choices) + AES-256-GCM `secrets.enc` (one key per provider, shared across slots) + chmod-600 machine-bound `master.key`. `isConfigured()` gate (≥2 candidates + judge + all referenced provider keys) refuses `fusion` until satisfied.
- **Provider layer** — `@earendil-works/pi-ai` bridge with per-call `apiKey` injection, `getProviders()`/`getModels()` for UI dropdowns, and a live test-ping endpoint. Model-override registry for dynamic providers.
- **Persistence** — SQLite (better-sqlite3, WAL) with `activities` (one per fusion) + `sub_calls` (N+2 per fusion) tables; aggregation queries power the dashboard's "activity as a dimension".
- **REST API** on `127.0.0.1:9077` — config, secrets (masked presence only), providers/models, test, stats, activity (paginated + expandable).
- **Glass-morphic React dashboard** (Vite + Tailwind + recharts) — Candidates, Judge, API Keys (with per-provider Test), and Dashboard pages with KPI cards, fusions-per-day line chart, cost-by-model + token-usage-by-model bar charts, and an expandable activity table.
- **`openfusion-ui` bin** — standalone always-on dashboard (survives independent of the MCP client).
- **`SKILL.md`** — agent guidance on when (and when not) to use Fusion, dropped into a client's skills folder.
- **`INSTALL.md`** — registration recipes for 18+ MCP clients (Claude Code, Cursor, Cline, Roo, Zed, Continue, Codex, Gemini CLI, Qwen Code, Kimi Code, Antigravity, opencode, Hermes, Claude Desktop, Codebuff, ZCode, and more).
- **Design record** — full speckit `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`, `tasks.md`.
- **38 tests** (vitest) — crypto round-trips, SQLite aggregations, worker timeout, two-step judge, fusion orchestration (success / partial / <2-survivor / judge-failure / wall-clock budget), config merge-and-validate, MCP handler + progress + gate. All deterministic via pi-ai faux providers.

### Security
- API keys encrypted at rest (AES-256-GCM); never logged; never returned unmasked from any API.
- Dashboard binds to `127.0.0.1` only.

### Conventions
- pnpm, TypeScript (ES2022, NodeNext, ESM), no bundler; `tsc` → `dist/`, Vite → `ui-dist/`.
- stdout reserved for MCP JSON-RPC; all logs to stderr.

[Unreleased]: https://github.com/hashangit/openfusion/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/hashangit/openfusion/releases/tag/v0.1.1
[0.1.0]: https://github.com/hashangit/openfusion/releases/tag/v0.1.0
