---
layout: page
navbar: false
aside: false
pageClass: of-home
---

<div class="of-home-root">

<header class="of-nav">
<div class="of-nav-inner">
<a class="of-nav-brand" href="/">
<img src="/logo-512.png" alt="OpenFusion logo" />
OpenFusion
</a>
<a class="of-nav-link" href="/docs/">Docs</a>
<a class="of-nav-link" href="/docs/how-it-works.html">How it works</a>
<a class="of-nav-link of-nav-link--icon" href="https://github.com/hashangit/openfusion" aria-label="OpenFusion on GitHub">
<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
</svg>
</a>
<a class="of-nav-cta" href="/docs/getting-started.html">Get started</a>
</div>
</header>

<section class="of-hero">
<div class="wrap">
<p class="of-eyebrow">A local MCP server · bring your own keys</p>
<h1 class="of-h1">
<span class="of-h1-line">Many models.</span>
<span class="of-h1-line"><em>One considered answer.</em></span>
</h1>
<p class="of-lede">
OpenFusion sends your prompt to a panel of AI models at once, then has a judge read
every answer and write the one that should ship. It runs on your machine, inside the
coding agent you already use.
</p>
<div class="of-cta-row">
<a class="of-btn of-btn-primary" href="/docs/getting-started.html">Get started</a>
<a class="of-btn of-btn-ghost" href="/docs/how-it-works.html">How it works</a>
</div>

<div class="of-stage">
<Confluence />

<div class="of-chip of-chip-1">
<span class="of-chip-dots" aria-hidden="true">
<i style="background:#8B8570"></i><i style="background:#8A6748"></i><i style="background:#3B6B4C"></i><i style="background:#4E7F9E"></i><i style="background:#A9BC90"></i>
</span>
<span><strong>2–5 models</strong> answer the same prompt<small>in parallel, single-shot</small></span>
</div>

<div class="of-chip of-chip-2">
<span><strong>A judge reads every answer</strong><small>consensus · contradictions · blind spots</small></span>
</div>

<div class="of-chip of-chip-3">
<span><strong>One answer comes back</strong><small>written from all of them, not averaged</small></span>
</div>

<div class="of-chip of-chip-stat">
<span>~¾ of the quality lift comes from the synthesis step<small>OpenRouter Fusion research</small></span>
</div>
</div>
</div>
</section>

<section class="of-section">
<div class="wrap">
<div class="of-section-head">
<p class="of-eyebrow">What it is</p>
<h2 class="of-h2">A fusion engine, <em>not another agent</em></h2>
<p class="of-section-lede">
OpenFusion does one thing well: it turns many single-shot answers into one
consolidated answer. It doesn't browse, click, or run tools — your agent does the
legwork and calls it once.
</p>
</div>

<div class="of-cards">
<div class="of-card">
<span class="of-card-icon of-card-icon--moss" aria-hidden="true">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
<path d="M12 4v6" /><path d="M12 10 5 18" /><path d="M12 10l7 8" /><path d="M12 10v10" opacity="0.45" />
</svg>
</span>
<h3>Fan out</h3>
<p>
Your prompt goes to 2–5 models in parallel — mix cheap and strong, from any
providers you like. Each candidate answers once, with its own timeout.
</p>
</div>
<div class="of-card">
<span class="of-card-icon of-card-icon--water" aria-hidden="true">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
<circle cx="12" cy="12" r="8.5" /><path d="M8.5 12.2l2.4 2.4 4.8-5" />
</svg>
</span>
<h3>Judge</h3>
<p>
A model you choose reads all surviving answers and maps where they agree, where
they contradict each other, and what every one of them missed.
</p>
</div>
<div class="of-card">
<span class="of-card-icon of-card-icon--wood" aria-hidden="true">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
<path d="M4 7h10" /><path d="M4 12h16" /><path d="M4 17h7" /><path d="M17 5v4" opacity="0.5" />
</svg>
</span>
<h3>One answer</h3>
<p>
The judge writes a single consolidated response and hands it back to your agent.
Every call is logged locally with cost, tokens, and latency.
</p>
</div>
</div>
</div>
</section>

<section class="of-section of-section--tint">
<div class="wrap">
<div class="of-section-head">
<p class="of-eyebrow">How it works</p>
<h2 class="of-h2">Three stages, <em>one river</em></h2>
</div>

<div class="of-how">
<div class="of-steps">
<div class="of-step">
<span class="of-step-num">1</span>
<div>
<h3>Fan out</h3>
<p>
2–5 candidates answer the same prompt in parallel. Single-shot — no tools, no
browsing. If a model stalls, its timeout fires and it's out.
</p>
</div>
</div>
<div class="of-step">
<span class="of-step-num">2</span>
<div>
<h3>Analyze</h3>
<p>
The judge compares the survivors: consensus, contradictions, partial coverage,
unique insights, and blind spots.
</p>
</div>
</div>
<div class="of-step">
<span class="of-step-num">3</span>
<div>
<h3>Synthesize</h3>
<p>
From the answers plus its own analysis, the judge writes one consolidated
answer. If fewer than two candidates survive, fusion stops instead of guessing.
</p>
</div>
</div>
</div>

<figure class="of-how-figure">
<Confluence />
<figcaption>the confluence — fusion, drawn as a river</figcaption>
</figure>
</div>
</div>
</section>

<section class="of-section">
<div class="wrap">
<div class="of-section-head">
<p class="of-eyebrow">When to reach for it</p>
<h2 class="of-h2">Four jobs it <em>earns its keep</em> on</h2>
</div>

<div class="of-when">
<div class="of-when-card">
<h3>Architecture decisions</h3>
<p>Where a second and third opinion genuinely change what you build.</p>
</div>
<div class="of-when-card of-when-card--water">
<h3>Deep research</h3>
<p>Synthesizing many sources and perspectives without dropping the edges.</p>
</div>
<div class="of-when-card of-when-card--wood">
<h3>High-stakes answers</h3>
<p>Independent models agreeing is real confidence, not vibes.</p>
</div>
<div class="of-when-card of-when-card--stone">
<h3>Budget quality</h3>
<p>A panel of cheap models, fused, can beat one expensive call.</p>
</div>
</div>
<p class="of-skip">
For routine edits and simple lookups, one model is faster and cheaper —
<em>fusion costs 2–3× a single call</em>, so use it where it pays.
</p>
</div>
</section>

<section class="of-section of-section--tint">
<div class="wrap">
<div class="of-section-head of-section-head--center">
<p class="of-eyebrow">Quick start</p>
<h2 class="of-h2">Zero to first fusion <em>in five minutes</em></h2>
<p class="of-section-lede">Requires Node.js 22+. Then add models and keys in the dashboard.</p>
</div>

<div class="of-terminal">
<div class="of-terminal-head" aria-hidden="true">
<i class="dot-1"></i><i class="dot-2"></i><i class="dot-3"></i>
<span class="of-terminal-title">first-fusion</span>
</div>
<pre class="of-terminal-body"><code><span class="of-cmt"># 1 · install the server</span><br />npm install -g openfusion-mcp<br /><br /><span class="of-cmt"># 2 · register it with your agent + install the skill</span><br />npx openfusion-setup<br /><br /><span class="of-cmt"># 3 · open the dashboard, add 2–5 models + a judge + keys</span><br />openfusion-ui</code></pre>
</div>
</div>
</section>

<section class="of-section">
<div class="wrap">
<div class="of-section-head of-section-head--center">
<p class="of-eyebrow">Works with</p>
<h2 class="of-h2">Anything that <em>speaks MCP</em></h2>
</div>

<div class="of-seepient">
<a class="of-seepient-pill" href="/docs/seepient.html">
<img src="/seepient-logo.svg" alt="Seepient logo" />
<span class="of-seepient-text"><strong>Seepient</strong> — our own agent, with first-class fusion support</span>
<span class="of-seepient-cta">See the pairing →</span>
</a>
</div>

<div class="of-chip-row">
<span class="of-client-chip">Claude Code</span>
<span class="of-client-chip">ZCode</span>
<span class="of-client-chip">Cursor</span>
<span class="of-client-chip">Cline</span>
<span class="of-client-chip">Zed</span>
<span class="of-client-chip">Codex</span>
<span class="of-client-chip">Gemini CLI</span>
<span class="of-client-chip">Continue</span>
<span class="of-client-chip">Claude Desktop</span>
<a class="of-client-chip of-client-chip--more" href="/docs/clients.html">+ 9 more →</a>
</div>
</div>
</section>

<div class="of-band-wrap">
<div class="wrap">
<div class="of-band">
<Confluence ghost />
<div class="of-band-inner">
<h2>Give your agent <em>a council.</em></h2>
<p>MIT licensed · runs locally · any providers · no lock-in</p>
<a class="of-btn of-btn-inverse" href="/docs/getting-started.html">Install OpenFusion</a>
</div>
</div>
</div>
</div>

<footer class="of-footer">
<div class="of-footer-inner">
<span class="of-footer-brand">
<img src="/logo-512.png" alt="" />
OpenFusion
</span>
<span>© 2026 Hashan Wickramasinghe · MIT</span>
<a href="https://github.com/hashangit/openfusion">GitHub</a>
<a href="/docs/">Docs</a>
<a href="https://github.com/hashangit/openfusion/releases">Releases</a>
</div>
</footer>

</div>
