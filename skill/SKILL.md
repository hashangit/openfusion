---
name: openfusion
description: Use the OpenFusion MCP server to fuse multiple LLMs' answers into one consolidated, higher-quality response for complex reasoning, deep research, and cross-model verification. Slower and costlier than a single call — only use when multiple perspectives add real value.
---

# OpenFusion

OpenFusion is an MCP server that implements OpenRouter's "Fusion" panel architecture locally. When you call the `fusion` tool, it sends your prompt to 2–5 configured candidate models in parallel, runs a two-step judge (structured analysis, then synthesis), and returns a single consolidated answer that integrates consensus, reconciles contradictions, and fills blind spots across the candidates.

## WHEN to use OpenFusion

Call `fusion` for tasks where multiple model perspectives genuinely improve the answer:

- **Complex reasoning** — tricky architectural decisions, multi-constraint design problems, subtle bugs where a second opinion helps.
- **Deep research / source synthesis** — questions requiring thorough analysis across angles.
- **Cross-model verification** — high-stakes answers where confidence that independent models agree is valuable.
- **Hard-to-judge factual or technical questions** where a single model's answer isn't trustworthy enough on its own.

## WHEN NOT to use OpenFusion

Do **not** call `fusion` for work a single model handles well. It is **2–3× slower and costlier** than a normal call:

- Routine coding, debugging, refactors, or file edits.
- Simple lookups, definitions, or single-turn Q&A.
- Trivial tasks — formatting, renaming, small fixes.
- Anything where one model's answer is already sufficient.

**Fusion is not a drop-in replacement for everyday model calls.** Default to the base model; reach for `fusion` selectively when the task warrants multiple perspectives.

## HOW to use it

OpenFusion is a **fusion engine, not an agent.** It does **not** call tools, browse the web, or gather information. Its only job is to fuse candidate outputs.

- Provide the `prompt` directly.
- If you've already gathered context (tool results, file contents, prior reasoning), pass it as `context` — OpenFusion includes it with the prompt for each candidate. Otherwise the candidates answer from the prompt alone.

```
fusion({ prompt: "<the question>", context: "<optional background you already gathered>" })
```

## Constraints

- **Minimum 2, maximum 5 candidate models.** The user configures these (plus the judge) in the dashboard.
- If OpenFusion returns `isError: true` directing you to `http://localhost:9077`, it isn't configured yet — tell the user to open that URL and set up candidates, a judge, and API keys.
- A fusion where some candidates fail (timeout/error) still returns a consolidated answer as long as ≥2 candidates succeeded. Fewer than 2 survivors returns an error.

## Setup reminder for the user

If the `fusion` tool reports the server is unconfigured, the user must open **http://localhost:9077** and configure:
1. 2–5 candidate models (provider + model each).
2. One judge model (used for both analysis and synthesis).
3. An API key for every provider referenced (one key per provider, shared across slots).

Configuration takes effect immediately — no restart needed.
