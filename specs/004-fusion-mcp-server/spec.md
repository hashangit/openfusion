# Feature Specification: Fusion MCP Server

**Feature Branch**: `004-fusion-mcp-server`

**Created**: 2026-06-15

**Status**: Draft

**Input**: User description: "Create an MCP server that works like OpenRouter's Fusion system. Any MCP client calls the server with a prompt; it gets fanned out into 2-5 candidate LLMs (preconfigured providers/models). Once all candidates complete, the candidates + prompt go to a judge (preconfigured provider/model), which assesses them and outputs one consolidated best answer. OpenFusion is a fusion engine, not an agent — the client supplies the prompt (and any context/tool results); workers do not call tools. Users configure candidate count, per-candidate provider/model, and judge provider/model. Provider management is handled inside the server via pi-ai. The server refuses to run until configured, and opens a local browser dashboard at port 9077 for setup. The dashboard also shows model/provider usage statistics and an activity log (activity as a dimension). A SKILL.md instructs client agents when/when-not to use OpenFusion."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Fuse a prompt and get one consolidated answer (Priority: P1)

An AI agent (in any MCP client — e.g. a coding assistant, a research tool, or a chat app) faces a question that benefits from multiple perspectives: a tricky architectural decision, a nuanced factual question, or a high-stakes answer where consensus adds confidence. The agent calls the OpenFusion tool with its prompt (and any background context or tool results it has already gathered). OpenFusion sends that prompt to each of the configured candidate models in parallel, collects their independent answers, then hands all of them to the judge. The judge first extracts a structured analysis (what the candidates agree on, where they contradict, what's only partially covered, what's a unique insight, and what's missing) and then writes a single consolidated answer using only the candidates and that analysis. The agent receives one final answer — the synthesized best version — and continues its work.

**Why this priority**: This is the core value of OpenFusion. Without it, nothing else matters. It is the entire reason the server exists.

**Independent Test**: With candidates and judge configured, call the OpenFusion tool with a prompt that benefits from multiple perspectives (e.g. "Compare the trade-offs of server-side vs. client-side session storage"). Verify a single consolidated answer is returned that reflects, not just repeats, the candidates, and that the activity log records the fusion with one activity entry and one sub-entry per candidate plus two judge sub-entries.

**Acceptance Scenarios**:

1. **Given** OpenFusion is fully configured (≥2 candidates, a judge, and a key for every referenced provider), **When** the agent calls the fusion tool with a prompt, **Then** a single consolidated answer is returned that synthesizes the candidates' outputs rather than echoing any one of them.
2. **Given** all candidates are configured, **When** the agent includes optional background context alongside the prompt, **Then** each candidate generates with that context taken into account, and the judge's final answer reflects the context.
3. **Given** a fusion is in progress, **When** one candidate is slow or fails, **Then** the fusion still completes using the candidates that succeeded, as long as at least two candidates succeeded.
4. **Given** a fusion completes, **When** the user later opens the dashboard, **Then** that fusion appears in the activity log with its per-candidate and per-judge-step breakdown (model, tokens, cost, latency, status).

---

### User Story 2 - Configure OpenFusion before first use (Priority: P1)

A user has just installed OpenFusion into their MCP client. Before they can fuse anything, they need to tell OpenFusion which providers and models to use for candidates and for the judge, and provide the API keys for those providers. When the agent first tries to use the fusion tool (or the user explicitly asks to set up), OpenFusion detects that it is not yet configured and opens a friendly browser-based setup dashboard at `http://localhost:9077`. There the user adds between two and five candidate slots (picking a provider and model for each), picks a judge provider and model, and enters the API key for each provider they referenced. The user can test that a chosen provider/model/key combination actually works before saving. Once saved, fusions work immediately — no restart needed.

**Why this priority**: Fusion is impossible without configuration. This is the gateway to Story 1 and is itself part of the MVP. Without a smooth, guided setup, the tool is unusable.

**Independent Test**: Starting from a fresh install (no config), call the fusion tool. Verify the user is directed to the setup dashboard, can configure two candidates + a judge + keys, can validate each with a test ping, and that immediately after saving, a fusion call succeeds.

**Acceptance Scenarios**:

1. **Given** OpenFusion is not configured, **When** the agent calls the fusion tool, **Then** it returns a clear message directing the user to `http://localhost:9077` to set up candidates, a judge, and API keys (and opens the browser when a display is available).
2. **Given** the setup dashboard is open, **When** the user adds candidate slots, **Then** they can add a minimum of two and a maximum of five candidates, each with a provider and model chosen from the providers/models the server supports.
3. **Given** the user has entered a provider key and chosen a model, **When** they trigger a test, **Then** they get immediate feedback on whether that provider/model/key works before saving.
4. **Given** the user has saved a complete configuration, **When** the agent calls the fusion tool again, **Then** it runs successfully without any restart of the MCP client.

---

### User Story 3 - Monitor usage and cost across providers (Priority: P2)

A user who has been fusing prompts wants to understand what OpenFusion is costing them and how it's behaving: how many fusions have run, which models are being used, what they're spending, how long calls take, and whether candidates are failing. They open the dashboard and see a usage overview (total fusions, total cost, total tokens, average latency, success rate), charts of cost and tokens over time and by model, and a filterable activity log. They can expand any past fusion to see the per-candidate and per-judge breakdown — which model said what, cost, tokens, latency — using the activity as the lens to slice and understand their usage.

**Why this priority**: Transparency and cost control. Not required for the first successful fusion, but essential for trust and for ongoing use. A user who can't see cost will stop using the tool.

**Independent Test**: Run several fusions of varying sizes, then open the dashboard. Verify the KPIs reflect the runs, the charts break down cost/tokens by model and over time, and each activity row expands to show its candidate + judge sub-calls.

**Acceptance Scenarios**:

1. **Given** several fusions have completed, **When** the user opens the dashboard's usage view, **Then** they see totals (fusion count, cost, tokens, average latency, success rate) accurate to the runs performed.
2. **Given** the usage view is open, **When** the user filters by date range, model, or status, **Then** the KPIs and charts update to reflect only the matching fusions.
3. **Given** an activity log entry, **When** the user expands it, **Then** they see one row per candidate and one row per judge step, each showing model, token usage, cost, latency, and status.

---

### User Story 4 - Know when (and when not) to use OpenFusion (Priority: P2)

An AI agent and its user need guidance on when calling OpenFusion is worth it and when it's overkill, because Fusion is two-to-three times slower and costlier than a single model call. The agent is given (via a skill it can load) clear, opinionated guidance: use OpenFusion for tasks that genuinely benefit from multiple perspectives or cross-model verification — complex reasoning, deep research, high-stakes answers where consensus adds value. Do not use it for routine work a single model handles well — simple lookups, single-turn Q&A, trivial coding, anything where one model's answer is enough. The guidance also reminds the agent that OpenFusion does not do agentic work or tool calls, so the agent must supply the prompt and any gathered context itself.

**Why this priority**: Without this guidance, agents either over-use Fusion (wasting cost and time) or never discover it. This unlocks correct usage. It is not a blocker for the first fusion, so P2.

**Independent Test**: Read the provided skill guidance. Verify it states concrete when-to-use and when-not-to-use categories, names the cost/latency trade-off, and notes that the agent must supply prompt + context. Confirm an agent following it would only call Fusion for multi-perspective tasks.

**Acceptance Scenarios**:

1. **Given** an MCP client agent supports skills and has loaded the OpenFusion skill, **When** the agent decides whether to fuse, **Then** it has explicit criteria distinguishing fusion-worthy tasks (complex reasoning, deep research, cross-model verification, high-stakes) from non-worthy tasks (routine lookups, single-turn Q&A, trivial work).
2. **Given** the skill is loaded, **When** the agent reads it, **Then** it understands Fusion is slower and costlier than a single call and must not be a drop-in replacement for everyday tasks.
3. **Given** the agent decides to fuse, **Then** it knows to supply the prompt and any relevant context/tool results itself, because OpenFusion will not call tools or gather information on its own.

---

### Edge Cases

- **Fewer than two candidates succeed**: If, after the fan-out, fewer than two candidates produced a valid response (the rest timed out or errored), the fusion cannot meaningfully synthesize — the tool returns an error explaining how many succeeded and which failed, rather than producing a low-quality single-source answer.
- **A candidate hangs**: A single slow or hung candidate must not sink the whole fusion. Each candidate has its own timeout; survivors proceed. The slow candidate is recorded as failed in the activity log.
- **The judge fails**: If the judge itself errors during analysis or synthesis, the fusion fails with a clear message; the partial candidate outputs and the failure are recorded in the activity log so the user can diagnose.
- **Unknown or invalid provider/model at config time**: If a user picks a provider or model the provider layer doesn't recognize, configuration is rejected with a clear message at save/test time — not at fusion time.
- **Missing API key for a referenced provider**: If a candidate or judge references a provider with no key stored, the fusion is treated as not-configured and the user is directed to the setup dashboard.
- **Running headless (no display)**: If there is no display to open a browser (e.g. a server or CI), the setup prompt just returns the dashboard URL as text instead of trying to launch a browser.
- **Client tool-call timeout pressure**: Because fusions are slow (parallel fan-out plus two judge steps), the design keeps total wall-clock bounded by running candidates in parallel and per-candidate timeouts, so a typical fusion completes within common client tool-call windows.
- **Reconfiguration mid-use**: A user changes candidates, judge, or keys via the dashboard while the server is running. New fusions immediately reflect the new configuration; any in-flight fusion finishes with the configuration it started with.
- **Concurrent fusions**: Multiple fusions run concurrently (e.g. the agent calls the tool several times). Each is independent; usage stats attribute each correctly.

## Requirements *(mandatory)*

### Functional Requirements

**Fusion & judging**

- **FR-001**: System MUST expose a single tool that, given a prompt, returns one consolidated answer synthesized from multiple independent candidate responses.
- **FR-002**: System MUST fan the prompt out to each configured candidate in parallel, where each candidate produces exactly one response and is never given tools or the ability to take actions.
- **FR-003**: System MUST accept optional context (background/tool results) alongside the prompt and include it in what each candidate sees.
- **FR-004**: System MUST wait for all candidates to finish (or time out) before judging, because the judge needs the full set of candidate outputs.
- **FR-005**: System MUST run the judge in two steps using the same provider and model: first a structured analysis of the candidates (consensus, contradictions, partial coverage, unique insights, blind spots), then a synthesis that produces the final answer using only the candidates and that analysis.
- **FR-006**: System MUST proceed to judging as long as at least two candidates succeeded; if fewer than two succeeded, it MUST return an error rather than a single-source answer.
- **FR-007**: System MUST bound each candidate's runtime with a per-candidate timeout, treating an over-time candidate as failed and continuing with the survivors.

**Configuration**

- **FR-010**: System MUST let the user configure between two and five candidate slots, each with a provider and a model, and one judge with a provider and a model.
- **FR-011**: System MUST refuse to run a fusion until at least two candidates, a judge, and a stored key for every referenced provider are all configured, returning a clear message directing the user to the setup dashboard.
- **FR-012**: System MUST detect provider and model availability from the underlying provider-management layer (so the user chooses from providers/models the server actually supports, rather than typing names blindly).
- **FR-013**: System MUST validate a chosen provider/model/key combination with a live test ping before the user commits it, so misconfiguration is caught at setup time.
- **FR-014**: System MUST apply saved configuration to subsequent fusions immediately, without restarting the server or the MCP client.

**Secrets**

- **FR-020**: System MUST store provider API keys locally and encrypted, never in plaintext.
- **FR-021**: System MUST never log provider API keys and MUST never return them except as masked indicators of presence.
- **FR-022**: System MUST keep its configuration dashboard reachable only from the local machine, never exposed to the network.

**Observability**

- **FR-030**: System MUST record, for every fusion, one activity entry capturing the prompt, the number of candidates, the judge model, totals (tokens, cost, latency), and a status.
- **FR-031**: System MUST record, for every fusion, one sub-entry per candidate plus one per each of the two judge steps, each capturing provider, model, tokens, cost, latency, and status — so usage can be analyzed per model and per role.
- **FR-032**: System MUST expose a usage dashboard showing totals (fusion count, cost, tokens, average latency, success rate), trends over time, and a breakdown by model, filterable by date range, model, and status.
- **FR-033**: System MUST let the user expand any past fusion in the activity log to see its per-candidate and per-judge-step sub-entries.

**Guidance**

- **FR-040**: System MUST ship a skill document that tells client agents when to use OpenFusion (complex reasoning, deep research, cross-model verification, high-stakes answers needing consensus), when not to use it (routine lookups, single-turn Q&A, trivial tasks a single model handles), the cost/latency trade-off, and the fact that the agent must supply the prompt and context because OpenFusion does not call tools.

### Key Entities *(include if feature involves data)*

- **Candidate Configuration**: One of 2–5 slots; represents a single worker with a chosen provider and model. Independent of all other candidates.
- **Judge Configuration**: A single provider + model used for both the analysis and synthesis steps.
- **Provider Key**: A stored credential for one provider; shared across every candidate and the judge that reference that provider (one key per provider, not per slot).
- **Fusion (Activity)**: One invocation of the tool. Has a prompt, optional context, a set of candidate results, two judge-step results, and aggregate totals. The central entity the dashboard is built around.
- **Sub-call**: A single LLM call within a fusion — either one candidate response or one judge step. The dimension along which a fusion is analyzed (per model, per role, per cost).
- **Dashboard Session**: A user's interaction with the local configuration/stats UI. Not persisted as data; it is the lens onto configuration, activity, and stats.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can go from a fresh install to a successful fusion in under 5 minutes, using only the in-browser setup dashboard.
- **SC-002**: A completed fusion returns a single consolidated answer whose content reflects synthesis across candidates rather than echoing any single candidate (verifiable by comparing the final answer against the candidate outputs).
- **SC-003**: A fusion in which one candidate fails or times out still returns a valid consolidated answer as long as at least two candidates succeeded.
- **SC-004**: The dashboard's usage totals (fusion count, cost, tokens, average latency, success rate) match the actual fusions performed, and each activity row expands to show its candidate and judge sub-calls.
- **SC-005**: A typical fusion (fan-out + two judge steps) completes within common client tool-call time windows, so the user is not presented with spurious timeouts on routine fusions.
- **SC-006**: Provider API keys are never present in plaintext at rest, never present in any log, and never returned unmasked from any dashboard endpoint.
- **SC-007**: An MCP-client agent given the shipped skill guidance correctly restricts OpenFusion calls to multi-perspective tasks and avoids using it for routine single-model work.

## Assumptions

- **Target users are developers or power users** running an MCP-capable client (e.g. a coding assistant or chat app) on their local machine, who are comfortable installing an MCP server and opening a local URL.
- **Single-user, local-only**: OpenFusion runs on one user's machine for one user. Multi-user, multi-tenant, or network-accessible deployments are out of scope for this feature.
- **The user has valid API keys** for the providers they want to use; OpenFusion obtains keys from the user via the dashboard, not from any third party.
- **Provider management is delegated to an underlying provider layer** (`@earendil-works/pi-ai`) that already abstracts multiple providers, exposes the list of supported providers and models, and reports per-call token/cost usage. OpenFusion builds configuration, secrets handling, fusion orchestration, and the dashboard on top of it.
- **MCP clients communicate with local servers over the standard stdio transport**, so OpenFusion follows that convention; the browser dashboard is a separate local HTTP surface, not part of the MCP protocol.
- **Fusion is a best-effort synthesis**, not a guarantee of a strictly better answer than the best single candidate; its value is in surfacing consensus, contradictions, and blind spots across models.
- **The dashboard's cost/token figures are best-effort**, derived from what the underlying providers report, and may be imprecise for aborted calls (a known limitation of the provider layer).
- **Out of scope for v1**: workers calling tools (web search, fetch, shell) as in OpenRouter's original Fusion — OpenFusion is a fusion engine, not an agent; OAuth-based provider login flows beyond storing a key; multi-user/network deployment; and server-side rate limiting or quotas.
