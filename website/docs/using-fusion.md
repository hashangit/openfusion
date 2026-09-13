---
title: Using the fusion tool
---

<p class="of-eyebrow">Use</p>

# Using the <em>fusion</em> tool

Once OpenFusion is configured, your agent has two tools:

| Tool | What it does |
| --- | --- |
| `fusion` | Sends a prompt to your panel and returns one consolidated answer |
| `open_dashboard` | Opens the dashboard at `http://localhost:9077` |

## The basic call

```js
fusion({
  prompt: "Should this worker use a queue or a streaming pull?",
  context: "<the relevant code, constraints, and what you've already tried>"
})
```

- **`prompt`** *(required)* — the question for the panel.
- **`context`** *(optional but powerful)* — anything the candidates should read: code,
  error output, constraints, prior findings. The workers can't browse or call tools, so
  the quality of a fusion is mostly the quality of the dossier your agent brings.

That's the whole working method, and the installed agent skill teaches it: **do the
legwork first, then call fusion once with a prepared question.** Fusion is 2–3× slower and
costlier than one model call, so it belongs on decisions and research, not on every edit.

## All parameters

| Parameter | Required | What it does |
| --- | :---: | --- |
| `prompt` | ✓ | The question the panel answers |
| `context` | | Supporting material: code, errors, constraints, findings |
| `persona` | | Run with a specific persona instead of the active one |
| `_resume_from` | | Retrieve the result of a slow fusion by its reference id — see [slow clients](#slow-clients-and-missing-results) |

While the panel runs, your client receives **progress notifications** — one per candidate
as it finishes, then the judge stages — so a 60-second fusion doesn't feel like silence.

## Personas

A persona bundles a panel (and sometimes a judge) for a specific kind of job. Typical use:
a cheap fast panel for research questions, a stronger panel for architecture reviews.

From your agent:

```
list_personas()          →  [{ id, name, description, builtin, active }]
fusion({ prompt: "...", persona: "code-reviewer" })
```

- The **active persona** is the default — set in the dashboard's Settings, under Personas.
- Passing a `persona` asks for a **temporary override**. By default it's allowed; under
  the `strict` policy the active persona runs instead and your agent is told why. Either
  way, a fusion runs — the policy decides whose panel answers.
- Passing an unknown persona id never errors: it falls back to the active persona.

## Slow clients and missing results

A fusion with several candidates plus a judge can take **30–90 seconds**. Some clients
enforce a tighter tool-call ceiling (often 60s) and give up early. When that happens, the
fusion usually **completed and was logged anyway** — check the dashboard's
[Playground](/docs/dashboard.html#playground) history or the Errors tab.

For clients with tight ceilings, OpenFusion supports a deferred protocol:

1. **Kick off:**

   ```js
   fusion({ prompt: "..." })
   ```

   Returns almost immediately with a `processing` status and a `reference_id`.

2. **Retrieve:**

   ```js
   fusion({ _resume_from: "<reference_id>" })
   ```

   Waits a little and returns the finished answer — byte-identical to the blocking call.
   If the fusion is still running and the wait budget runs out, you get a refined ETA and
   can call again.

The deferred result is durable: it survives server restarts, so retrieving it in a fresh
session works too.

## Reading a fusion's aftermath

Every fusion is recorded locally:

- **One activity row** per fusion — total cost, tokens, duration.
- **One row per sub-call** — each candidate plus the two judge steps — so you can see
  exactly which model contributed what, at what price, and how long it took.

The [dashboard](/docs/dashboard.html) turns this into per-model cost and token
charts and an expandable activity log; the Playground's history rail lets you re-read any
past fusion's full answer and breakdown.

---

<div class="of-next">

**Next up**

- [The dashboard](/docs/dashboard.html)
- [Troubleshooting & FAQ](/docs/troubleshooting.html)

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
