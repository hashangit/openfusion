# Contributing to OpenFusion

Thanks for your interest in improving OpenFusion! This is a small, focused project and we keep the bar for changes deliberately high — see [`AGENTS.md`](./AGENTS.md) for the coding guidelines every contribution must follow (think before coding, simplicity first, surgical changes, goal-driven execution).

## Quick start

```bash
git clone https://github.com/<owner>/openfusion.git
cd openfusion
pnpm install          # use pnpm, not npm
pnpm build            # tsc -> dist/ ; vite -> ui-dist/
pnpm test             # deterministic, uses pi-ai faux providers (no real API calls)
pnpm dev              # tsx watch (server); pnpm --filter ./ui run dev (UI)
```

Requirements: Node.js 22+, pnpm. better-sqlite3 needs its native addon (pnpm handles prebuilt binaries; if your platform lacks one, it falls back to building from source).

## Project layout

```
src/        TypeScript server (ESM, ES2022, NodeNext) — see ARCHITECTURE.md
ui/         React + Vite + Tailwind dashboard (its own package.json)
skill/      SKILL.md — agent guidance, shipped with the package
tests/      vitest; uses @earendil-works/pi-ai registerFauxProvider()
specs/      speckit design docs (spec/plan/tasks/contracts) — the design record
```

## Constitution

OpenFusion has a [constitution](./.specify/memory/constitution.md) — seven non-negotiable principles. Changes that violate a principle (especially the NON-NEGOTIABLE ones) require explicit justification in the PR description. Please read it before designing a change.

## How to contribute

1. **Open an issue first** for anything beyond a typo or bugfix — a short proposal saves everyone time. Scope-creep PRs that add features nobody asked for will be declined (Constitution VII: "Start simple, YAGNI").
2. **Branch off `main`**: `feat/<short-name>`, `fix/<short-name>`, or `docs/<short-name>`.
3. **Follow the guidelines in [`AGENTS.md`](./AGENTS.md)** — match existing style, touch only what your change requires, no speculative abstraction.
4. **Tests are required** for any change to `src/fusion/`, `src/config/`, `src/store/`, or `src/server/`. Use `registerFauxProvider()` — never a real API call in the suite. Run `pnpm test` before pushing.
5. **Keep the typecheck green**: `pnpm typecheck` (strict mode is on).
6. **One logical change per PR.** Surgical changes (AGENTS.md §3) — every changed line should trace to the issue.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add tokensByModel chart
fix: merge partial config on PUT so incremental setup works
docs: expand install guide for Gemini CLI
test: cover judge-failure logging path
chore: pin @earendil-works/pi-ai
```

## Secrets & safety

- **Never commit an API key**, a `config.json`, a `secrets.enc`, or a `.db` file. The `.gitignore` covers these, but double-check your diff.
- The dashboard binds to `127.0.0.1` only — keep it that way (Constitution IV).
- If you find a security issue, please don't open a public issue; email the maintainer instead.

## Adding a new MCP client to the install guide

Client registration details change fast. When updating [`INSTALL.md`](./INSTALL.md):

- Verify the config file path and JSON shape against the client's **current official docs** (link the source).
- Test the snippet actually works if you can.
- Update the support matrix.

## Releasing

Releases follow `MAJOR.MINOR.PATCH` (semver). The maintainer handles: update `CHANGELOG.md`, tag `vX.Y.Z`, push, publish the GitHub release. `@earendil-works/pi-ai` is pre-1.0 — keep it pinned exact (`save-exact`).

## Code of conduct

Be kind and constructive. We're all here to make a useful tool.
