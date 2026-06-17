# OpenFusion workflows

The five patterns referenced in [SKILL.md](../SKILL.md), in detail. For each: what to gather *before* calling, how to shape the call, and what a good dossier looks like. Read the section for the pattern you're about to use.

Common thread across all of them: **you assemble the dossier with your own tools first; OpenFusion never gathers anything.** The quality of the fused answer is bounded by the quality of what you pass in.

---

## 1. Code review / QA (after implementing)

You've written something non-trivial and want a panel to review it before you call it done. The panel acts as your QA/senior reviewers.

**Before you call**, gather:
- The **diff** (or the new/changed files in full, if the diff is meaningless without context).
- The **requirements/intent** — what was this supposed to do? What are the invariants?
- **Surrounding context** a reviewer needs — the types, the callers, the constraints (e.g. "must stay under 100ms", "must not break the public API").
- **Anything you're unsure about** — edge cases you suspect, perf concerns.

**Shape the call:**
- `prompt`: the review question. Be specific about what you want: "Review this for correctness bugs, edge cases, and security. Flag anything that would break under load." beats "review this."
- `context`: the diff + requirements + relevant surrounding code.

**Good dossier includes:** the actual code (not a paraphrase), the success criteria, the known constraints, and a direct ask. The panel then returns a consolidated verdict: bugs found (with severity), missed edge cases, and suggested improvements — synthesized across the candidates.

**Don't:** call fusion to review a one-line change, a rename, or anything you can eyeball. Call it for logic, security, concurrency, or anything high-stakes.

---

## 2. Debug root-cause (after reproducing)

A bug is misbehaving and you want the panel to reason about the root cause and the fix. You act as the investigator; OpenFusion acts as the debug council.

**Before you call**, gather:
- The **failing behavior** — exact symptom, what you expected, what happened.
- The **error / stack trace / logs** — verbatim, not paraphrased.
- The **relevant code** you've already read and narrowed down (not the whole repo — the suspect surface).
- **Reproduction steps** you've confirmed.
- **Your hypotheses and what you've ruled out** — this saves the panel from retreading ground and focuses them.

**Shape the call:**
- `prompt`: "Given this symptom and trace, what is the most likely root cause, and what's the minimal fix? Explain the mechanism." Add any constraints ("must not change the public API", "fix must be backward-compatible").
- `context`: the symptom + trace + suspect code + repro + what you've tried.

**Good dossier includes:** the literal error, the actual code path, and your ruled-out list. The panel debugs from the evidence; the judge consolidates the most-supported root cause and a defensible fix.

**Don't:** call fusion with "my app is broken, why?" and nothing else. Don't call it before you've reproduced or read any code — do that first.

**After:** you implement the fix yourself using your tools. The fused answer is guidance, not applied code (OpenFusion can't edit files).

---

## 3. Research consolidation (after gathering)

You've collected a pile of material — docs, snippets, API references, prior-art notes — and you want it argued into one well-reasoned answer. OpenFusion is your synthesis panel.

**Before you call**, gather:
- The **source material** — quotes, snippets, links' contents, notes. Paste the substance in (OpenFusion can't browse).
- The **question** the research must answer.
- **Conflicts/gaps you noticed** — "source A says X, source B says Y; which holds?"

**Shape the call:**
- `prompt`: the question + any explicit instruction ("weigh these trade-offs and recommend", "synthesize into a design", "give me the canonical answer with caveats").
- `context`: the gathered material, organized.

**Good dossier includes:** the actual source substance (not "I read the docs and…"), the decision you're trying to inform, and the contradictions you want resolved. The panel argues from the material; the judge reconciles into one justified answer.

**Don't:** ask fusion to "research X" with no sources provided — it has no web access. Gather first.

---

## 4. Architecture / plan review (before building)

You're about to build something substantial and want a panel to pressure-test the approach before you commit.

**Before you call**, gather:
- The **goals and non-goals**.
- The **constraints** — performance, scale, existing systems, deadlines, team skills.
- The **options you're weighing** (or your leading approach, if you have one).
- The **open questions** where you want a push.

**Shape the call:**
- `prompt`: "Review this architecture for {goals} under {constraints}. Where will it break? What's the riskier assumption? Is there a simpler approach I'm missing?"
- `context`: goals, constraints, the design/options.

**Good dossier includes:** the real constraints (not "should scale" but "~500 RPS, p99 < 200ms"), the alternatives, and a direct ask about risk. The panel surfaces assumptions and blind spots you'd otherwise hit later.

**Don't:** call it for a design so simple one model could sanity-check it, or before you've thought through the constraints yourself.

---

## 5. Second opinion (high-stakes / irreversible)

A decision is about to be made that's expensive to reverse (a production rollout, a data migration, a public statement, a delete). You want independent agreement before you act.

**Before you call**, gather:
- The **decision** and the **reasoning** that led you to it.
- The **evidence** supporting it.
- The **downside scenario** you most fear.

**Shape the call:**
- `prompt`: "I'm about to {decision}. My reasoning is {X}. Where is this reasoning weakest? What would have to be true for this to be the wrong call?"
- `context`: the decision + reasoning + evidence + risks.

**Good dossier includes:** your actual reasoning (so the panel can attack it, not just the conclusion) and the failure mode you're guarding against. The panel acts as adversarial reviewers; the judge consolidates the strongest dissent and any confirmed agreement.

**Don't:** use this for low-stakes or easily-reversed choices — it's overkill.
