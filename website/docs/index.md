---
title: What is OpenFusion?
---

<p class="of-eyebrow">Introduction</p>

# What is <em>OpenFusion</em>?

OpenFusion asks several AI models the same question, then has one more model read all of
their answers and write a single, better one. It runs on your machine, inside the coding
agent you already use — Claude Code, Cursor, Cline, Zed, Codex, Gemini CLI, and many more.

It appears to your agent as an ordinary MCP server with one useful tool: `fusion`. When your
agent calls it, OpenFusion sends the prompt to **2–5 models of your choice in parallel**, has
a **judge model** compare the answers, and returns **one consolidated response**.

## Where the idea comes from

OpenRouter studied this pattern — they call it **Fusion** — and found two things:

- A panel of cheap models, fused together, **outperformed solo frontier models** on
  deep-research tasks, landing within about 1% of the best at a fraction of the cost.
- Most of that lift doesn't come from having many models — it comes from the
  **synthesis step**: splitting "analyze the candidates" from "write the final answer".

OpenFusion brings that exact architecture to your own machine with your own API keys. No
subscription, no middleman — the calls go from your computer straight to the providers you
configure.

## What you get

- **The `fusion` tool** — your agent calls it whenever a question deserves more than one
  opinion. It returns one answer, with progress updates along the way.
- **The `open_dashboard` tool** — opens a local web dashboard at
  `http://localhost:9077`.
- **A local dashboard** — configure models and keys, run fusions by hand in the
  Playground, and inspect every past fusion: which model said what, cost how much, took
  how long.
- **An agent skill** — a small guide installed next to your agent that teaches it *when*
  fusion is worth a call, so it doesn't over-use it.

## When fusion earns its keep

- **Architecture and design decisions**, where a second and third opinion change what you
  build.
- **Deep research**, where answers need synthesizing rather than retrieving.
- **High-stakes calls**, where independent models agreeing is real confidence.
- **Budget quality** — a panel of cheap models, fused, can beat one expensive call.

And when to skip it: routine edits, simple lookups, quick one-off questions. Fusion is
2–3× slower and costlier than a single call, so it pays for itself only on questions that
deserve the panel.

## What you need

- **Node.js 22 or newer**
- **Any MCP-capable agent or client** — see [Connect your agent](/docs/clients.html)
- **An API key for at least two providers** — or none at all, if you use the built-in
  keyless providers (`rapid-mlx` for local Apple-Silicon inference, `ollama-cloud`)

---

<div class="of-next">

**Next up**

- [How it works](/docs/how-it-works.html) — the fan-out and the judge, in plain words
- [Installation](/docs/getting-started.html) — zero to first fusion in ~5 minutes

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
</style>
