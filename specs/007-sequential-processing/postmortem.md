# Post-mortem — Parallel fusion progress frozen at "0 of N responding"

**Feature**: 007-sequential-processing | **Date**: 2026-06-19 | **Bug found via**: `/scrutinize` pass 1

## 1. Summary

The live server-status widget (feature 007, US3) showed a **parallel** fusion as "0 of N candidates responding" for the entire run, then made it vanish on completion — the progress count never rose. The sequential affordance worked; only parallel was broken. Root cause: the parallel fan-out path wired no `onUpdate` to the status registry, and `runParallelFanout` exposed no per-completion hook to call. Fixed by adding an `onUpdate` callback to `runParallelFanout` that fires in completion order as each worker resolves, wired in `runFusion` to `fusionStatusRegistry.update`. Regression test `T010b` added; teeth-checked (reverts red). PR: feature 007 commit (this branch). Owner: implementation agent.

## 2. Symptom

A parallel fusion observed via `GET /api/runtime` (or the Dashboard widget) showed `candidatesDone: undefined` for its entire lifetime. The widget rendered `"Running — 0 of N candidates responding"` frozen, because `fusionLine()` does `done = f.candidatesDone ?? 0`. The registry entry appeared on `enter`, sat untouched, and was cleared on `leave` — no intermediate updates. For a fast cloud fusion this was barely visible; for a slow one it was indistinguishable from "hung at zero" — the exact failure mode US3 exists to prevent.

## 3. Root cause

Two missing pieces, one in each layer:

- **`src/fusion/fanout.ts`** — `runParallelFanout(calls)` was `return Promise.all(calls.map(c => runWorker(c)))`. `Promise.all` resolves only when *all* mapped promises settle; it provides no per-completion hook. So even if a caller wanted to observe intermediate progress, there was no seam to do so. (Contrast: `runSequentialFanout` had an `onUpdate` param from the start, because the `for…of` loop knows each completion as it happens.)
- **`src/fusion/fusion.ts:212`** — the parallel branch called `runParallelFanout(workerCalls)` with no options. Only the sequential branch wired `onUpdate` → `fusionStatusRegistry.update(activityId, { candidateIndex, candidatesDone })`. So the registry entry for a parallel fusion was `enter`ed (with `candidatesDone` unset) and `leave`d, never updated between.

The registry itself (`status.ts`) and the widget (`Dashboard.tsx`) were correct — they faithfully rendered whatever `candidatesDone` carried. The bug was that nothing in the parallel path ever set it.

## 4. Why it produced the symptom

`runFusion` calls `fusionStatusRegistry.enter(activityId, mode, candidateCount)` on start, which creates an entry with `candidateCount` set but `candidatesDone` *absent* (optional field). The widget reads `f.candidatesDone ?? 0` → `0`. With no `update` call in between, that `0` persisted until `leave` deleted the entry. So the widget showed a static "0 of N" that looked identical whether 0 or N workers had actually responded. The sequential path didn't have this because its `onUpdate` was wired from day one.

## 5. Fix

- **`src/fusion/fanout.ts:43`** — `runParallelFanout` now accepts `{ onUpdate?: (candidatesDone: number) => void }`. Implementation: a `let done = 0` counter incremented inside a `.then` on each `runWorker(c)`, calling `onUpdate(done)` as each resolves. The returned array stays in input/slot order (Promise.all semantics); only the side-effect callback observes completion order. Safe because `runWorker` never rejects (full try/catch in `worker.ts:31-75` converts all exceptions to `status:"error"` results), so `Promise.all` never short-circuits mid-count.
- **`src/fusion/fusion.ts:212`** — parallel branch now wires `onUpdate: (candidatesDone) => fusionStatusRegistry.update(activityId, { candidatesDone })`.

This addresses the root cause (no per-completion seam + no wiring) rather than hiding the symptom (e.g., a fake "estimating…" affordance).

## 6. How it was found

- **Repro**: `tests/fanout-sequential.test.ts` `T010b` — runs a real `runFusion` in parallel mode, spies on `fusionStatusRegistry.update`, asserts the `candidatesDone` sequence is `[1, 2, 3]`. Deterministic.
- **Debugging path**: First attempt polled the registry every 20ms and asserted `maxDoneSeen >= 1`. It failed *even with the fix applied*. Tracing (`console.error` inside the wiring + the poller) revealed the fix worked — `onUpdate` fired 1,2,3 — but all three fired in a single microtask batch at the end, because faux workers resolve near-simultaneously and `Promise.all`'s `.then` callbacks drain together. The poller sampled only before and after that batch, never during. **Hypothesis rejected**: "the fix is wrong." **Confirmed**: "the test can't observe intermediate state through polling when workers are fast." Fix for the test: spy on `registry.update` directly (tests the real production path runFusion → fanout → registry) instead of polling the registry from outside.
- **Single experiment that confirmed cause**: temporarily reverted the wiring (`runParallelFanout(workerCalls)` with no opts); the spy-based test failed with `expected [] to deeply equal [1, 2, 3]` — proving both the bug and the test's teeth.

## 7. Why it slipped through

**Review miss (mock hid the path).** The original status-surface test `T022` (in `tests/status-surface.test.ts`) asserted the registry produces a correct parallel affordance — but it did so by calling `fusionStatusRegistry.update(...)` *manually*, then reading the snapshot. It never exercised the production code path (`runFusion` → `runParallelFanout` → `update`). So it asserted behavior the production parallel path never produced. The test passed; the bug shipped. Classic "test mocks the very call it claims to verify."

The deeper gap: there was no test that ran a real `runFusion` in *parallel* mode and observed the registry. All the fan-out tests used parallel mode to verify *fusion output* (which worked), and the status tests verified the *registry* in isolation (which worked) — but nothing joined the two for the parallel case.

## 8. Validation

- `T010b` (`tests/fanout-sequential.test.ts`) now passes: a real parallel `runFusion` produces `registry.update` calls with `candidatesDone` rising `[1, 2, 3]`. Teeth-checked: reverting the wiring makes it fail (`[]`).
- Full suite: **105/105** (was 104 before the regression test).
- Typecheck clean (backend + UI).
- **Not validated**: a real slow multi-model parallel run (would require live provider keys + slow models). The mechanism is verified; the live UX (watching the count rise over ~seconds) is the one eyeball check left.

## 9. Action items

- Regression test added at the runFusion→fanout→registry seam: `T010b`. (Implementation agent, merged in this feature's commit.)
- **Class-of-bug follow-up**: when a feature adds a new side-effect seam (here, `onUpdate`), add at least one test that drives it through the *production caller* (`runFusion`), not just the primitive in isolation. The status-surface tests for the *sequential* path happen to exercise production code via the real fan-out; the parallel one didn't, because parallel's seam didn't exist yet. General rule captured here; no separate ticket.
- None other — the fix is sufficient.
