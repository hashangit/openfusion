---
title: How it works
---

<p class="of-eyebrow">Introduction</p>

# How it <em>works</em>

OpenFusion is a **fusion engine, not an agent**. It doesn't browse the web, click around,
or call tools. Your agent does the legwork — reads the code, runs the searches, gathers the
facts — then hands OpenFusion a prepared question. OpenFusion does one thing with it: turns
many single-shot answers into one considered answer.

## The three stages

<Confluence />

1. **Fan out.** Your prompt goes to 2–5 **candidate models** in parallel, each answering
   once. Workers get no tools and no second tries — they're opinions, not oracles. Each
   candidate runs under its own timeout, so a stalled model can't hold up the panel.

2. **Analyze.** The **judge model** — a model you pick — reads all of the surviving answers
   and produces a structured comparison: where the candidates **agree** (consensus), where
   they **disagree** (contradictions), what only some of them covered, and what all of
   them **missed** (blind spots).

3. **Synthesize.** The judge writes **one consolidated answer** using only the candidates'
   answers and its own analysis — no new information, no second round of calls. This
   two-step split (analyze, then write) is where most of the quality lift comes from.

## The rules the engine keeps

- **At least two candidates must survive.** If timeouts or errors leave fewer than two
  answers, fusion stops with an error rather than presenting a shaky majority as consensus.
- **Both judge steps use the same model.** You configure one judge; it does the analysis
  and the writing.
- **Everything is logged.** Each fusion writes one activity record plus one row per
  sub-call (each candidate + the two judge steps) into a local SQLite database — which
  model said what, cost how much, took how long.
- **One call in, one answer out.** From your agent's point of view, `fusion` is just a
  tool that takes a prompt (plus optional context) and returns text.

## What it is not

- **Not an agent.** No tools, no browsing, no memory between calls. Bring the context; it
  brings the panel.
- **Not a router.** It doesn't pick one model's answer — it writes a new answer from all
  of them.
- **Not a cloud service.** The engine, the dashboard, the database, and your keys all live
  on your machine. API traffic goes only to the providers you configure.

::: tip Why the judge matters
OpenRouter's research found that roughly **three-quarters of the quality lift comes from
the synthesis step itself**, not just from model diversity. That's why OpenFusion treats
"compare the candidates" and "write the final answer" as two deliberate stages.
:::

---

<div class="of-next">

**Next up**

- [Installation](/docs/getting-started.html) — set it up in four steps
- [Configuration](/docs/configuration.html) — pick your panel and your judge

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
.vp-doc > div > .confluence,
.vp-doc .confluence {
  max-width: 420px;
  margin: 12px auto 28px;
}
</style>
