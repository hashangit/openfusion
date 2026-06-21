# Leadership Update — OpenFusion 0.3.0

**Channel:** written status report (JIRA-comment shape)

---

**Status: Shipped.** OpenFusion 0.3.0 is merged to main, published to npm. 171 tests green.

**Impact.** The headline change removes a hard ceiling on fusion length for MCP clients. Before 0.3.0, any fusion longer than the client's ~60-second tool-call timeout would be silently killed — the fusion ran fine server-side, but the client gave up waiting and the user never saw the answer. This affected every non-Tasks MCP client (codex, ZCode) and every long-running fusion (research, deep reasoning, sequential local-model runs). After 0.3.0, the call returns in ~1 second and the agent retrieves the synthesized answer on its own schedule. A ~90-second fusion now returns in ≤3 agent round-trips; a 20-minute sequential run returns with a live-progress dashboard link.

**What shipped.** Four features, one architectural decision:

- **Deferred retrieval (`_resume_from`)** — the protocol that lets non-Tasks clients get long-fusion results without timing out. A kickoff returns immediately with a reference id; the agent retrieves via `_resume_from`.
- **MCP Tasks support** — Tasks-aware clients (Claude Code) get the same benefit via native task polling. Verified end-to-end with a 452-second fusion.
- **Persona discovery + policy** — agents can now enumerate personas and pick one; users can gate client overrides via a strict/allow-override policy.
- **Sequential fan-out** — an opt-in mode for low-VRAM local setups (Ollama, llama.cpp) that runs candidates one at a time instead of concurrently.

The architectural decision: the deferred-retrieval protocol required replacing the MCP SDK's internal request handler to intercept calls before the SDK's blocking auto-poll runs. This is a deliberate coupling to SDK internals, documented in three places and guarded by a canary test. On SDK upgrade, the canary catches shape changes at test time; if the SDK ever removes the blocking path, the override becomes a no-op and can be deleted.

**A bug the review cycle caught.** During a three-pass code review, we found that the stalled-fusion detector's threshold was too aggressive — it would have marked healthy sequential fusions as "stalled" mid-run (sequential candidates legitimately run 3–9 minutes between progress callbacks). The fix: a per-fusion threshold computed from the configured worker timeout, plus a rule that a genuine completion overrides a speculative stall classification. The bug was latent — the test suite used short worker delays that didn't trigger it. It would have surfaced on the first real sequential run in production.

**Why it matters for users.** OpenFusion's core value proposition — fusing multiple models for better answers — is now practical for the workloads where it matters most: long research fusions, deep-reasoning runs, and sequential local-model setups where VRAM constraints forced one-at-a-time execution. The client-timeout ceiling was the single biggest barrier to using fusion for non-trivial work.

**Owner.** Hashan Wickramasinghe. Merged via `v0.3.0-upgrade` → `main` (commit `b6901fc`).

**Next steps.**
- Manual end-to-end validation against real codex with real provider keys (T029).
- v0.3.1 candidates: durable task store (so Tasks-path fusions survive restarts), cancellation wiring (`tasks/cancel`).
- SDK upgrade vigilance: the handler-override coupling means SDK upgrades need the canary-test gate.

**Risk.** The SDK handler override is the one fragile surface. If `@modelcontextprotocol/sdk` changes its internal handler shape in a future release, the `_resume_from` path could silently degrade to pre-008 blocking behavior. Mitigated by: the canary test (catches at test time), the documented upgrade checklist (in `resume-dispatch.ts` header + AGENTS.md), and the fact that the degradation is graceful (non-Tasks clients fall back to the old blocking path, not a crash).
