# OpenFusion: good vs bad calls

The fastest way to internalize the mental model is to see bad and good versions of the same call. Read this if your fusion results feel generic, shallow, or like the panel is guessing.

**Why quality varies:** the panel sees only what you pass. A vague prompt produces vague, hedged answers from every candidate, so the judge has nothing real to reconcile. A dossier-rich prompt produces specific, disagreeing, useful answers — which is what the judge is good at consolidating.

---

## Pattern: bad → good

### Bad (debug)
```
prompt: "my auth service keeps crashing, any ideas?"
context: (none)
```
The panel has nothing to go on. You'll get generic checklists ("check your logs", "is it OOM?") that you could've written yourself.

### Good (debug)
```
prompt: "Given this stack trace and the suspect code, what is the most likely root cause of the crash, and what's the minimal fix? I've already ruled out A and B."
context: |
  SYMPTOM: POST /auth/token returns 500 ~2% of requests, only under load.
  TRACE:
    NullPointerError at AuthService.issueToken (auth/service.ts:84)
      at RateLimiter.check (auth/ratelimit.ts:31) ...
  SUSPECT CODE:
    // auth/service.ts lines 78-90
    const user = users.get(req.userId);      // line 84: NPE here
    const token = sign(user.id, user.roles);
  REPRO: only when userId is set but the users cache has evicted it.
  RULED OUT: DB connectivity (fine), JWT signing (works in isolation).
  CONSTRAINT: fix must not change the /auth/token contract.
```
Now the panel can reason specifically (cache-eviction race, stale userId), disagree productively, and the judge gives you a defensible root cause + fix.

---

### Bad (review)
```
prompt: "review my PR"
context: (link, or nothing)
```
OpenFusion can't open links. Even with code pasted, "review my PR" gets you a surface scan.

### Good (review)
```
prompt: "Review this diff for correctness bugs, edge cases around null/empty inputs, and any way the cache could return stale data. Flag severity."
context: |
  REQUIREMENT: getUser(id) must return fresh data within 60s of a write.
  DIFF:
    -function getUser(id){ return cache.get(id) ?? db.load(id); }
    +function getUser(id){ const c=cache.get(id); if(c) return c; const v=db.load(id); cache.set(id,v,300); return v; }
  CALLERS: 3 handlers, all in request path (latency-sensitive).
  CONCERN I have: does the 300s TTL violate the 60s freshness requirement?
```
The panel reviews against *your* specific worry and the stated invariant — far more useful than a generic scan.

---

### Bad (architecture)
```
prompt: "should I use microservices?"
```
Endless generic debate; the judge reconciles nothing useful.

### Good (architecture)
```
prompt: "For a real-time collab editor serving ~2k concurrent users/room, p99 < 200ms, team of 4, on this existing monolith — is splitting the collab service out worth it? What's the riskiest assumption in doing so? Is there a simpler path?"
context: |
  GOALS: 2k concurrent users/room, p99 < 200ms, sub-second presence.
  CONSTRAINTS: team of 4, existing Postgres monolith, no ops team.
  CURRENT: single Node process, WS fan-out; CPU-bound serialization at ~500 users.
  OPTIONS I'M WEIGHING: (a) extract collab into a separate service w/ Redis fan-out, (b) stay monolith, optimize serialization, (c) move to CRDT lib.
```
Concrete trade-offs → concrete disagreement → useful synthesis.

---

## Templates

Steal these; fill the brackets.

**Debug:**
```
prompt: Given this symptom and trace, what's the most likely root cause and the minimal fix? I've ruled out {A, B}.
context: SYMPTOM: {...}; TRACE: {...}; SUSPECT CODE: {...}; REPRO: {...}; CONSTRAINT: {...}.
```

**Review:**
```
prompt: Review this for {correctness / security / edge cases / perf}. Flag severity. I'm specifically worried about {X}.
context: REQUIREMENT: {...}; CODE/DIFF: {...}; CALLERS/CONTEXT: {...}; CONSTRAINT: {...}.
```

**Research:**
```
prompt: Weigh these sources and answer {question}. Resolve the conflict between {A says X, B says Y}.
context: {source quotes/snippets, organized, with the decision this must inform}.
```

**Architecture:**
```
prompt: Review this approach for {goals} under {constraints}. Where will it break? What's the riskiest assumption? Simpler alternative I'm missing?
context: GOALS: {...}; CONSTRAINTS: {...}; CURRENT: {...}; OPTIONS: {...}.
```

**Second opinion:**
```
prompt: I'm about to {decision}. My reasoning: {...}. Where is this weakest? What would have to be true for this to be wrong?
context: DECISION: {...}; EVIDENCE: {...}; FAILURE MODE I FEAR: {...}.
```

---

## Smells that mean "don't call fusion"

- You haven't read the code / run anything yet. → Do the groundwork first.
- The question is "what is X" / "how do I Y" with a known answer. → Answer directly or search.
- You're about to call it a third time on the same problem. → Stop; prepare one good dossier instead.
- The prompt fits in one line and has no `context`. → Probably too thin to be worth a fusion.
- You're using it as a first step. → It's a late-stage council.
