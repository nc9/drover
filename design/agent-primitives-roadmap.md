# Drover as an agent primitive framework: assessment and roadmap

Status: proposal. Audience: Drover maintainers. Written 2026-11-11 against `main` (04e87fb); refreshed 2026-11-12 against `main` (fa67a59) after the first merges (#6, #7, #13, #33/#42, CI #30, release #31, repo docs #32). Tracking epic: #15.

Goal: Drover should be a very capable agent primitive framework: small, typed pieces that compose, each with a clear contract, none of them an opinionated agent. This document assesses it primitive by primitive. "Exists" means found in the code at the path given. Items marked (read) were checked by reading code, not by running it.

## Status of the PRs this roadmap tracks

| PR       | Issue    | What                                                                                                                        | State (2026-11-12)                                                   |
| -------- | -------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| #6       | #16      | provider errors and empty completions fail the run                                                                          | merged                                                               |
| #7       | #17      | provider chain with classified failover, `provider_failover` event, usage per provider                                      | merged                                                               |
| #13      | #27      | trace format v1: versioned schema, tolerant reader, JSONL, summary, storage round trip, untrusted-field marks and redaction | merged                                                               |
| #42      | #33      | shared `SandboxAdapter` conformance suite; `none` kills process trees                                                       | merged                                                               |
| #35, #36 | #30, #31 | CI on every PR and `main`; tag-triggered release with provenance, lockstep bump                                             | merged                                                               |
| #40      | #32      | MIT licence, `SECURITY.md`, `CONTRIBUTING.md`, README, templates                                                            | merged                                                               |
| #8       | #19      | untrusted-data fence, fail closed (`createFence`, `untrustedResultsPlugin`)                                                 | open, final security review                                          |
| #9       | #25      | `toolCallCapPlugin` (caps, near-cap warning, `usage(runId)`)                                                                | open, reviewed, merge pending                                        |
| #5       | #24      | `@droveragent/facade/core` Worker-friendly entry                                                                            | open, reviewed, merge pending (Workers runtime test deferred to #46) |
| #14      | #28      | `beforeModelCall` hook and host-level balance preflight                                                                     | open, reviewed, merge pending                                        |
| #2       | #21      | continue a finished run (`resumeAgent` with `appendMessages`), `usageDelta`                                                 | draft                                                                |
| #3       | #22      | eval record and replay of provider responses via `streamFn`                                                                 | draft                                                                |
| #4       | #23      | `withProviderCost`: provider-billed cost as `Usage.costUsd`                                                                 | draft                                                                |
| #10      | #26      | `quota.wrapUp`: graceful finish before a budget is spent                                                                    | draft                                                                |
| #12      | #18      | structured provider errors via a per-attempt response tap                                                                   | draft                                                                |
| #47      | #44      | provider chain routes models whose provider is not in the chain                                                             | draft                                                                |
| #50      |          | `maxTurns` is a budget: a validated answer on the last turn ends `success`                                                  | draft                                                                |

## Summary

Drover is strongest where the loop is: declarative specs, plugins, durable pause/resume, compaction, subagents, MCP, sandboxes, skills, memory. The first merges closed the two worst production gaps: a provider failure is now a failed run (#6), and a run can fail over between providers mid-run (#7). Trace format v1 (#13) gives viewers and run-to-run comparisons a stable contract, and CI and a provenance-signed release pipeline (#30, #31) now guard `main`.

What remains is mostly at the edges that decide whether an unattended agent is trustworthy: what the model reads from outside (#8, in final review), how a run ends inside a budget (#10), structured provider errors (#12; the model layer, pi-ai, still flattens errors and hides response metadata), and a few contract decisions (approvals, parallel tools).

## Primitive by primitive

### 1. Model and provider abstraction

- Exists: `packages/model` (alias resolution, `ModelSpec`, per-provider env keys, `preResolved` models), pi-ai underneath; `HarnessDeps.streamFn` and `onPayload` seams; `cacheRetention`; circuit breaker plugin (tool-level). Since #6: a provider error or empty completion ends the run `error` with a `ProviderError`. Since #7: `createProviderChain` (ordered pi-ai providers, classified failover inside a call, `provider_failover` events, usage per provider), re-exported by the facade.
- Missing: structured provider errors (#12); rate-limit awareness beyond one `Retry-After` wait; provider-level prompt-cache control beyond `none|short|long`; routing of models whose provider is not in the chain (#44, draft #47).
- Smallest next step: land #12, then decide whether to keep the tap or push the fix upstream.
- Root cause worth its own line: pi-ai flattens a failed call to the SDK's text (`"403 <message>"`) and drops the response body and headers; `onResponse` is not called for non-2xx, so `Retry-After` and the body `code` are invisible. #7 classifies status-first from the SDK's leading status, so a region refusal arrives as `key_refused` over the built-in transport. Fix: pi-ai keeps `status`, `code`, `limit_source` and headers as fields on the error (upstream), or Drover's per-attempt response tap (#12) records them.
- Security note, applies to every classifier: provider error text echoes request content, which can contain outside text. Never classify from message text; status first, structured fields only, state scoped to one run. #7 follows this.

### 2. Tools: schemas, validation, errors, parallel calls, call caps

- Exists: TypeBox tool definitions with input decode, built-in tools, tool errors returned as `is_error`, `beforeToolCall` allow/deny, `wrapTool`, per-tool `timeoutMs`, truncate plugin with `show_tool_result`, dedup, loop-detect. #9 (pending): `toolCallCapPlugin` with per-run and per-tool caps, an actionable refusal, a near-cap warning, counts kept across pause/resume.
- Missing: parallel tool calls (the loop runs `toolExecution: "sequential"`) (read); output schemas for tools; per-tool retry; a guard against resending an already-refused call (#37, which should not fingerprint the cap's own refusals: a structured deny code is the clean fix).
- Smallest next step: land #9; expose `toolExecution` on the spec with a per-tool `concurrencySafe` flag (#29).

### 3. Structured output with repair

- Exists: `outputSchema`, `outputRetries` self-correction with `output_retry` events, `outputValidatePlugin`.
- Missing: JSON repair before spending a retry turn; provider-native structured output as an option; a typed report of which retry fixed what.
- Smallest next step: a pure `repairJson(text)` step in front of decode, with a counter in the event (#29).

### 4. Budgets: turns, tokens, cost, wall clock, graceful finish

- Exists: `quota.maxTurns|maxCostUsd|maxDurationMs`, `QuotaExceededError`, `quota` status. #14 (pending) adds admission control before each model call (`beforeModelCall`), on which the balance preflight is built.
- Missing: token budget; graceful finish (#10); per-continuation budgets (#2); billed rather than list-price cost for non-OpenRouter providers (#4); a `maxTurns` edge case where a validated answer on the last turn should end `success` (draft #50).
- Smallest next step: land #10; add `maxTokens` and per-invocation budgets for `appendMessages` runs.

### 5. Context management and compaction

- Exists: compaction ladder (`packages/harness/src/compaction`, `design/compaction.md`), manual and auto triggers, checkpoints store compacted history, `beforeCompaction`. Since #7 the summariser goes through the chain's transport when a chain is configured.
- Missing: the summariser still ignores a bare `streamFn` without a chain; token counting is an estimate; no cache-aware compaction.
- Smallest next step: route the summariser through `streamFn` always; measure cache loss from a pass.

### 6. Memory

- Exists: `packages/memory` (adapter, markdown store, BM25 recall, `remember`/`recall`/`forget`, rate limit). With #8: `MemoryEntry.trusted` (absent by default), untrusted index entries and `recall` fenced, frontmatter `trusted` ignored unless `allowTrustedFrontmatter`. With #5: the file loaders import `node:fs` lazily.
- Missing: embeddings-based recall (a dependency decision); a durable memory adapter for Workers (D1 or KV); which run wrote an entry.
- Smallest next step: record the writing run id on entries.

### 7. Skills

- Exists: `packages/skills` (`SKILL.md` loader, `skill_load`, `skill_resource`, allowlist, progressive disclosure). With #8, `skill_load` and `skill_resource` output and lifecycle `skill` steps are fenced.
- Missing: version in the spec hash beyond file content; a skills eval.
- Smallest next step: include skill name and version in `hashSpec`.

### 8. Subagents

- Exists: `taskTool`, depth and fan-out caps, child lifecycle events; children inherit `deps` (so a provider chain applies). With #8 the fence plugin is inherited by every child with its own nonce and `task` results are fenced in the parent.
- Missing: per-child budgets carved from the parent's; result schemas for children; parallel children are not replayable under #3 (call-index keying); the tool-call cap and balance preflight apply to a child only if its own spec carries them.
- Smallest next step: child budget slice (`quota` as a fraction of the parent's remaining).

### 9. Human approval and permission hooks

- Exists: `confirmGatePlugin`, `writePolicyPlugin`, `bashBlocklistPlugin`, `beforeToolCall` deny, pause/resume; #14 adds `beforeModelCall` refusal.
- Missing: input rewriting in `beforeToolCall` (documented as planned), a typed approval record in the trace, timeouts on pending approvals, a structured code on deny decisions (#37 needs it).
- Smallest next step: the approval decision (who, when, what) as an event.

### 10. Untrusted-data handling as a first-class primitive

- Exists on `main`: trace format v1 marks untrusted fields (`UNTRUSTED_FIELDS`), a `trust` hint on `tool_call_end`, HTML-safe JSONL and a redaction hook (#13).
- In #8 (final security review, eight review rounds): `createFence()` (per-run nonce, NFKC, look-alike and invisible-character tables, lone surrogates, tag escaping, bounds) and `untrustedResultsPlugin`.
  - It fences every tool result unless the tool is on one `trusted` allowlist (with a `NEVER_TRUSTED` list it refuses), plus stored copies by their own provenance, the compaction summary, untrusted memory entries, subagent results and lifecycle `mcp` and `skill` output.
  - The harness applies the fence outermost and last, so plugin order cannot weaken it. Only exact strings the plugin produced pass verbatim; forged blocks are fenced again.
  - It injects its own note, keeps a run's nonce stable (refusing a resume whose nonce is lost), and cleans and allowlists MCP tool descriptions and schemas.
- Provenance rule (the invariant to keep): **anything a tool returns is untrusted unless positively marked trusted, and the mark is stored with the data it describes. Fail closed.** Fence by provenance, never by content; "already fenced" is never inferred from text.
- Missing: a harness-level `ToolResult.untrusted` flag so fencing does not depend on a plugin at all (#20); the remaining hardening follow-ups (#45); a durable `NonceStore` example for cross-process resume.
- Smallest next step: land #8; then #20.

### 11. Durable and resumable runs

- Exists: checkpoints per turn, `paused` status, `resumeAgent` with spec id and hash validation, libsql/memory/D1 storage, runtime queue with leases and crash recovery.
- Missing: continuing a finished run (#2); concurrency control on resume; idempotent tool side effects across resume; continuing a run refused by the balance preflight after a top-up (comes with #2).
- Smallest next step: land #2 with a lease on resume.

### 12. Streaming

- Exists: `HarnessEvent` stream as `AsyncIterable`, opt-in `assistant_delta` and `thinking_delta`.
- Missing: tool-call argument deltas (dropped by design), backpressure contract, SSE/HTTP adapter (out of scope in `CLAUDE.md`).
- Smallest next step: none urgent.

### 13. MCP client

- Exists: `packages/mcp` (stdio and HTTP transports, `<server>__<tool>` prefixing, per-agent allowlist, runtime lifecycle). With #8: results fenced by default; descriptions cleaned and capped; input schemas reduced to a keyword allowlist with identifier-like names and token-like enum values; tools with unsafe names or schemas refused; `callTool` only reaches offered tools.
- Missing: auth flows for remote servers; resource and prompt support (read).
- Smallest next step: none until #8 lands.

### 14. Sandboxes

- Exists: `SandboxAdapter`, `none`, just-bash (default), Vercel and Cloudflare adapters. Since #42: a shared conformance suite (`sandboxConformanceCases`, `runSandboxConformance`) run against `none` and just-bash; `none` kills the whole process tree on timeout, abort and host exit or signal.
- Missing: the suite against the Vercel and Cloudflare adapters (#41, needs executing fakes); resource limits as part of the contract.
- Smallest next step: #41.

### 15. Tracing with a stable trace format

- Exists: since #13, trace format v1 (`packages/core/src/trace.ts`): `TRACE_VERSION`, `REQUIRED_FIELDS` exhaustive over event kinds at compile time, tolerant reader, JSONL export, `summarizeTrace`, storage round trip for every kind, untrusted-field marks and redaction. #7 added the `provider_failover` row.
- Missing: the `budget_warning` row (with #10); reasoning tokens in `Usage` (#43); an OTel exporter (declared out of scope, kept as a clean slot).
- Smallest next step: add rows as #10 lands.

### 16. Evals with record and replay

- Exists: in-repo suite (`evals/run.ts`, scenarios, fixtures), eval-viewer app; `packages/eval` is a stub on `main`.
- Missing: reusable `ScenarioRunner`/`Scorer`/`Reporter`; replay (#3); replay that tolerates parallel subagents; a public failure-injection fake provider (#7's tests are a start).
- Smallest next step: land #3; expose `streamFn` in the facade; publish the failure-injection fake.

### 17. Runtime targets and bundle size

- Exists: Bun/Node. #5 (pending): `@droveragent/facade/core`, a bundle of about 2.1 MB minified with every provider (1.0 MB with one), guarded by a test that fails on a Node-only import at module load or a size over 2.4 MB. The file loaders import `node:fs` lazily, so the static graph has only `node:path` and `node:crypto` (both provided with `nodejs_compat`). `sandbox: "disabled"` for no filesystem or shell. A Workers guide.
- Missing: a run on the Workers runtime in CI (#46, Miniflare); a durable Workers memory adapter; pi-ai's generated model table is about 400 KB.
- Smallest next step: land #5, then #46.

### 18. Balance preflight

- #14 (pending): `beforeModelCall` admission control and `balancePreflightPlugin` with an OpenRouter source. A refused call is never sent and adds no usage, turn or checkpoint; lookup and estimate failures follow `onUnknown`.
- Missing: the OpenRouter source checked once against the live API (`/credits` may need a management key; a key's own cap is `/key` `limit_remaining`); a balance capability on chain providers (#49).
- Smallest next step: land #14; one live check with a real key.

## Ranked next ten changes

1. Land #8 (fence), #9 (call cap), #5 (Workers entry) and #14 (balance preflight), all reviewed; then the harness-level `ToolResult.untrusted` flag (#20).
2. Structured provider errors (#12): decide whether to keep the tap or push the fix upstream into pi-ai; removes the region-as-key-refused limitation and enables honest rate-limit waits.
3. Land #10 (graceful finish) with its `budget_warning` trace row; land #50 (`maxTurns` budget semantics).
4. Land #2 (continue a finished run) with per-continuation budgets and a lease on resume.
5. Land #3 (record/replay), expose `streamFn` in the facade, publish the failure-injection fake provider.
6. Run the Workers entry on workerd in CI (#46).
7. Parallel tool calls with a per-tool concurrency-safe flag, structured-output repair, token budget (#29).
8. The refused-call repeat guard (#37) with a structured deny code.
9. Conformance suite for the Vercel and Cloudflare sandbox adapters (#41).
10. Reasoning tokens in `Usage` (#43); the first `0.3.0-next.1` release once the train is in (#34).

## Open questions for Nik

- A shared (cross-run) provider circuit breaker: only if driven by status-backed structured classifications. Until decided, state is per run.
- Should the harness add the fence note to the system prompt itself when a fence is configured? Today (with #8) the fence plugin injects it through `systemPromptAddendum`, so a host using the plugin gets it; a host fencing by hand still adds it.
- The facade now depends on `@droveragent/model` (#7) to re-export the chain. Acceptable, or keep the chain import separate?
- pi-ai: fork, upstream, or wrap, for structured errors (#12 wraps) and reasoning tokens (#43).
- Publishing: nothing new has been published. The plan is lockstep `0.3.0-next.N` on the `next` dist-tag (#34); it needs the owner setup in `RELEASING.md` (npm-publish environment, tag ruleset, `NPM_TOKEN`) first.

## What was not verified

Everything about live providers: the chain, billed cost and the OpenRouter balance source are tested against local servers or injected `fetch` with documented statuses and bodies, not against OpenRouter or the Cloudflare AI Gateway. The Workers entry is verified by bundling only (#46 is the runtime test). Items marked (read) were read in code but not run.
