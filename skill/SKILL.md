---
name: openfusion
description: Use the OpenFusion `fusion` tool to get a consolidated council-of-models answer for a hard, high-stakes decision — code review/QA after implementing, debug root-cause from a dossier you gathered, research consolidation, architecture/plan review, or a second opinion. Do the groundwork yourself first (read, code, search, reproduce), then call fusion ONCE with a rich dossier. Use it whenever you face a complex judgment where one model's answer isn't enough and the cost of being wrong is high — even if the user doesn't say "fusion."
---

# OpenFusion

**OpenFusion is your panel of expert reviewers, not another worker.** You are the executor: you read the code, run the tools, gather the evidence, and do the implementation. When you hit a genuinely hard judgment — one where a single model's answer isn't trustworthy enough and being wrong is expensive — you bring a **prepared dossier** to OpenFusion and get one consolidated answer back. Then you act on it.

A `fusion` call fans your prompt out to several models in parallel and a judge reconciles their answers into one (consensus, contradictions resolved, blind spots surfaced). It's ~2–3× slower and costlier than a normal call, and it returns **one** answer — so it rewards calling it once, well-prepared, over calling it repeatedly.

## The mental model

- **You do the legwork.** Read files, run searches, reproduce the bug, write the code, gather sources. OpenFusion does none of this — it has no tools and sees only what you pass it.
- **Bring a dossier, not a question.** A good fusion call hands the panel everything a senior reviewer would need: the relevant code, the error/trace, what you've tried, the constraints. `"how do I fix my bug?"` is a bad call; the bug + the failing code + the trace + your hypotheses is a good one.
- **One call per hard problem.** Don't loop on fusion to incrementally work something. Prepare, ask once, read the answer, proceed. Don't call it again to validate its own answer.

## Pre-flight gate (run this before every `fusion` call)

Call `fusion` only when **all three** are true:

1. **I've already gathered the concrete material** (code/diff/error/reproduction/sources) — or the task is genuinely pure reasoning that needs no external input.
2. **A single capable model probably isn't enough** — the decision is subtle, contested, high-stakes, or benefits from independent perspectives.
3. **The stakes justify the wait** — being wrong is costly (production bug, irreversible action, architecture you'll build on).

If any is false, don't call fusion: do the work yourself, or answer directly.

## When to use it

- **Code review / QA** — *after* you've implemented something non-trivial; pass the diff + relevant files + requirements.
- **Debug root-cause** — once you've reproduced and gathered the trace + suspect code + hypotheses; pass the dossier.
- **Research consolidation** — after you've gathered sources/notes/snippets; pass the pile to be argued into one well-reasoned answer.
- **Architecture / plan review** — before you build; pass the goals, constraints, and options.
- **Second opinion** — a high-stakes, irreversible decision where you want independent agreement.

## When NOT to use it

- Routine coding, edits, refactors, lookups, formatting, single-turn Q&A — anything one model handles.
- As a *first* step ("let me ask fusion what to do"). It's a late-stage council, not a starter.
- In a loop to chip away at a problem. Prepare, then ask once.
- To answer something you already know or could trivially verify.

## How to call it

```
fusion({ prompt: "<the specific question for the panel>", context: "<the dossier: code, errors, what you tried, constraints>" })
```

`context` is where the dossier goes — it's included with the prompt for every candidate. Put the concrete material there; keep the `prompt` the crisp question you want answered.

## Going deeper (read on demand)

- **`references/workflows.md`** — the five named patterns above in full: what to gather before each, how to shape the prompt, what a good dossier looks like. Read it the first time you use fusion for a given pattern (review, debug, research, architecture).
- **`references/examples.md`** — side-by-side bad-vs-good fusion calls + tuned prompt templates. Read it if your fusion results feel generic or shallow.

## Constraints

- Min 2 / max 5 candidate models (max lifts in Benchmark Mode); exactly 1 enabled judge. The user configures these in the dashboard.
- If a call returns `isError: true` pointing to `http://localhost:9077`, OpenFusion isn't configured — tell the user to open that URL and set up candidates, a judge, and API keys. No restart needed.
- Partial failures are fine: if some candidates time out or error but ≥2 succeed, you still get a consolidated answer. Only <2 survivors returns an error.
- **Long calls are non-blocking on Tasks-aware clients** (MCP Tasks / SEP-1686): the `fusion` tool returns a task handle immediately and the client fetches the result when ready, so a 2–10 minute fusion will not trip a client tool-call timeout. On non-Tasks clients it falls back to a single blocking call. You don't drive the polling — the client/host handles it transparently. Just call `fusion` as normal; the result comes back the same way regardless of path.
