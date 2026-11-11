# Drover as an agent primitive framework: assessment and roadmap

Status: proposal. Audience: Drover maintainers. Written 2026-11-11 against `main` (04e87fb) and the open draft PRs #2 to #10.

Goal: Drover should be a very capable agent primitive framework: small, typed pieces that compose, each with a clear contract, none of them an opinionated agent. This document assesses it primitive by primitive. "Exists" means found in the code at the path given. Items marked (read) were checked by reading code, not by running it.

Open PRs referenced:

| PR | What |
|---|---|
| #2 | continue a finished run (`resumeAgent` with `appendMessages`), `usageDelta` |
| #3 | eval record and replay of provider responses via `streamFn` |
| #4 | `withProviderCost`: provider-billed cost as `Usage.costUsd` |
| #5 | `@droveragent/facade/core` Worker-friendly entry |
| #6 | provider errors and empty completions fail the run |
| #7 | provider chain with classified failover, `provider_failover` event, usage per provider |
| #8 | untrusted-data fence (`createFence`, `untrustedResultsPlugin`) |
| #9 | `toolCallCapPlugin` |
| #10 | `quota.wrapUp`: graceful finish before a budget is spent |

## Summary

Drover is strongest where the loop is: declarative specs, plugins, durable pause/resume, compaction, subagents, MCP, sandboxes, skills, memory. It is weakest at the edges that decide whether an unattended agent is trustworthy in production: what happens when the provider fails, what the model reads from outside, how a run ends inside a budget, and what the trace says afterwards. The open PRs close most of those; what remains is mostly one root cause (the model layer, pi-ai, flattens errors and hides response metadata) and a handful of contract decisions (trace format, approvals, parallel tools).

## Primitive by primitive

### 1. Model and provider abstraction

- Exists: `packages/model` (alias resolution, `ModelSpec`, per-provider env keys, `preResolved` models), pi-ai underneath; `HarnessDeps.streamFn` and `onPayload` seams (`packages/harness/src/deps.ts`); `cacheRetention` on the model spec; circuit breaker plugin (`packages/plugins/src/circuit-breaker.ts`, tool-level).
- Missing: fallback and retry policy (#7 adds fallback); rate-limit awareness beyond one `Retry-After` wait; structured provider errors (see below); a balance preflight; provider-level prompt-cache control beyond `none|short|long`.
- Smallest next step: land #6 then #7. Then make errors structured (below).
- Covered by: #6, #7 (fallback, classification, per-provider usage), #4 (billed cost, OpenRouter only).
- Root cause worth its own line: pi-ai flattens a failed call to the OpenAI SDK's text (`"403 <message>"`) and drops the response body and headers; `onResponse` is not called for non-2xx, so `Retry-After` and the body `code` are invisible. #7 therefore classifies status-first, from the SDK's leading status, and a region refusal arrives as `key_refused` over the built-in transport. Fix: pi-ai keeps `status`, `code`, `limit_source` and headers as fields on the error (upstream), or Drover adds a per-attempt response tap (the mechanism #4 already uses for billed cost) that records status, parsed error body fields and `Retry-After` into the attempt.
- Security note, applies to every classifier: provider error text echoes request content, which can contain outside text. Never classify from message text; status first, structured fields only, state scoped to one run. #7 follows this.
- Open question (needs Nik): a shared circuit breaker across runs (so a dead provider is skipped fleet-wide) is valuable, but only safe if driven by status-backed, structured classifications, never by text; until then cooldowns are per run and per provider.

### 2. Tools: schemas, validation, errors, parallel calls, call caps

- Exists: TypeBox tool definitions with input decode (`packages/core/src/tool.ts`), built-in tools (`packages/tools`), tool errors returned to the model as `is_error`, `beforeToolCall` allow/deny, `wrapTool`, per-tool `timeoutMs` field, truncate plugin with `show_tool_result` (`packages/plugins/src/truncate.ts`), dedup, loop-detect.
- Missing: parallel tool calls (the loop is configured `toolExecution: "sequential"`, `packages/harness/src/run.ts`) (read); call caps (#9); output schema for tools; per-tool retry.
- Smallest next step: land #9; expose `toolExecution` on the spec with a per-tool `concurrencySafe` flag.
- Covered by: #9.

### 3. Structured output with repair

- Exists: `outputSchema`, `outputRetries` self-correction loop with `output_retry` events (`run.ts`), `outputValidatePlugin`.
- Missing: JSON repair before spending a retry turn (trailing commas, fences, partial objects); provider-native structured output (response_format) as an option; a typed report of which retry fixed what.
- Smallest next step: a pure `repairJson(text)` step in front of decode, with a counter in the event.
- Covered by: none.

### 4. Budgets: turns, tokens, cost, wall clock, graceful finish

- Exists: `quota.maxTurns|maxCostUsd|maxDurationMs`, `QuotaExceededError`, `quota` status.
- Missing: token budget; graceful finish (#10); per-continuation budgets (a continued run shares the original budget, noted in #2); cost on billed rather than list price for non-OpenRouter providers.
- Smallest next step: land #10; add `maxTokens` and a per-invocation budget for `appendMessages` runs.
- Covered by: #10 (graceful), #4 (billed cost), #2 (names the cumulative-budget gap).

### 5. Context management and compaction

- Exists: compaction ladder (`packages/harness/src/compaction`, `design/compaction.md`, `docs/guides/compaction.mdx`), manual and auto triggers, checkpoints store compacted history, `beforeCompaction` plugin hook.
- Missing: the summariser ignored `streamFn` (fixed under a provider chain in #7 only); token counting is an estimate; no cache-aware compaction (compaction invalidates the cached prefix).
- Smallest next step: route the summariser through `streamFn` always (today only under #7's chain); measure cache loss from a pass.
- Covered by: partly #7.

### 6. Memory

- Exists: `packages/memory` (adapter, markdown store, BM25 recall, `remember`/`recall`/`forget` tools, rate limit).
- Missing: embeddings-based recall (a dependency decision), memory provenance (which run wrote it, and whether its source was untrusted).
- Smallest next step: record provenance and the fence flag on entries written from fenced data, so recalled text is re-fenced.
- Covered by: none (#8 supplies the fence).

### 7. Skills

- Exists: `packages/skills` (`SKILL.md` loader, `skill_load`, `skill_resource`, allowlist, progressive disclosure).
- Missing: version in the spec hash beyond file content; a skills eval (does the skill change behaviour).
- Smallest next step: include skill name and version in `hashSpec`.
- Covered by: none.

### 8. Subagents

- Exists: `taskTool` (`packages/harness/src/task-tool.ts`), depth and fan-out caps, child lifecycle events on the parent stream; children inherit `deps` (so a provider chain applies to them, #7).
- Missing: per-child budgets carved from the parent's; result schemas for children; parallel children are not replayable under #3 (call-index keying).
- Smallest next step: child budget slice (`quota` as a fraction of the parent's remaining).
- Covered by: none.

### 9. Human approval and permission hooks

- Exists: `confirmGatePlugin` (pause for confirmation, `PausedForConfirmationError`), `writePolicyPlugin`, `bashBlocklistPlugin`, `beforeToolCall` deny, pause/resume.
- Missing: input rewriting in `beforeToolCall` (documented as planned), a typed approval record in the trace, timeouts on pending approvals.
- Smallest next step: the approval decision (who, when, what) as an event.
- Covered by: none.

### 10. Untrusted-data handling as a first-class primitive

- Exists: nothing before #8. Instruction-file loaders and the prompt builder treat all text as trusted.
- Added by #8: `createFence()` (per-run nonce, NFKC, look-alike brackets, control characters, bounds, escaping) and `untrustedResultsPlugin`.
- Provenance rule (the invariant to keep): **anything a tool returns is untrusted unless positively marked trusted, and the mark is stored with the data it describes. Fail closed.** Fence by provenance, never by content: tool output is the untrusted part, so a result containing a fence-shaped string (right tag without nonce, wrong nonce, a real opening tag followed by instructions after a closing tag) is still wrapped, and "already fenced" is never inferred from text; the opt-out is an explicit tool list. This covers the error and defect channel (an upstream error can echo a page title), self-fenced tools, and every stored or derived copy of a result (`show_tool_result`, a dedup cache hit, a summary, a recalled memory). Provenance lives in the stored entry (written at store time by the code that knows the producing tool, keyed by run id and tool-use id), not in side maps of ids; a missing entry, a legacy entry without the flag, another run's entry or a failed call reads as untrusted. #8 implements this for tools and `show_tool_result`; dedup and memory still need the same treatment.
- Missing: automatic `fence.note()` in the system prompt when a fence is configured; fencing of MCP results and skill resources by default; memory provenance (primitive 6); a model-input "taint" flag carried by tool results so the rule is enforced by the harness rather than by plugin ordering.
- Smallest next step: a `ToolResult.untrusted` flag set by tools and honoured by the harness (one wrap point, no plugin order dependence).
- Covered by: #8.

### 11. Durable and resumable runs

- Exists: checkpoints per turn, `paused` status, `resumeAgent` with spec id and hash validation, libsql/memory/D1 storage, runtime queue with leases and crash recovery (`packages/runtime`).
- Missing: continuing a finished run (#2); concurrency control on resume (two resumes of one run); idempotent tool side effects across resume.
- Smallest next step: land #2; add a lease on resume.
- Covered by: #2.

### 12. Streaming

- Exists: `HarnessEvent` stream as `AsyncIterable`, opt-in `assistant_delta` and `thinking_delta` (`emitDeltas`).
- Missing: tool-call argument deltas (dropped by design), backpressure contract, SSE/HTTP adapter (out of scope in `CLAUDE.md`).
- Smallest next step: none urgent.
- Covered by: none.

### 13. MCP client

- Exists: `packages/mcp` (stdio and HTTP transports, `<server>__<tool>` prefixing, per-agent allowlist, runtime lifecycle).
- Missing: auth flows for remote servers, result fencing (primitive 10), resource and prompt support (read).
- Smallest next step: fence MCP results through the same flag.
- Covered by: none.

### 14. Sandboxes

- Exists: `SandboxAdapter`, `none`, just-bash (default), Vercel and Cloudflare adapters (`packages/sandbox*`).
- Missing: a conformance test suite every adapter runs; resource limits as part of the contract.
- Smallest next step: shared adapter conformance tests.
- Covered by: #5 touches the sandbox entry (`sandbox: "none"` disabled sandbox).

### 15. Tracing with a stable trace format

- Exists: `HarnessEvent` union (`packages/core/src/events.ts`), persisted by storage, `stepTracerPlugin`, `phaseRecorderPlugin`, eval-viewer app.
- Missing: a version on the trace; a documented stable schema; persistence tests for new event kinds (`provider_failover`, `budget_warning` are not verified against the storage layer); reasoning tokens in `Usage`; OTel exporter slot (declared out of scope, kept as a clean slot).
- Smallest next step: `traceVersion` on `run_start`, a JSON schema generated from the union, a storage round-trip test for every event kind.
- Covered by: none. #7 and #10 add kinds, which makes this more urgent.

### 16. Evals with record and replay

- Exists: in-repo suite (`evals/run.ts`, scenarios, fixtures), eval-viewer app; `packages/eval` is a stub on `main`.
- Missing: reusable `ScenarioRunner`/`Scorer`/`Reporter`; replay (#3); replay that tolerates parallel subagents; a failure-injection harness (fake providers for every class: #7's tests are a start).
- Smallest next step: land #3; expose `streamFn` in the facade; build the failure-injection fake from #7's tests as a public helper.
- Covered by: #3.

### 17. Runtime targets and bundle size

- Exists: Bun/Node. #5 adds `@droveragent/facade/core` (browser bundle 2.08 MB, 1.02 MB with other provider SDKs externalised, per #5's measurements).
- Missing: a verified Workers run (only bundling is verified in #5); `memory`, `skills` still import `node:fs`/`node:crypto` at module level; pi-ai's generated model table is about 400 KB.
- Smallest next step: land #5; run the facade/core entry in a Workers test (miniflare) in CI.
- Covered by: #5.

### 18. Balance preflight

- Exists: nothing.
- Missing: a hook so a provider that exposes a balance (OpenRouter `/credits`) can be checked before a run starts, failing fast or choosing the provider order.
- Smallest next step: optional `balance(): Promise<{remainingUsd}>` on `ProviderSpec`, consulted once per run by the chain; strictly advisory (a failed or slow lookup never blocks a run). Not built tonight: it needs a decision on whether it belongs in the chain or in the host.
- Covered by: none.

## Ranked next ten changes

1. Land #6 (provider errors fail the run), then #7 (provider chain). They are one story: #7's exhausted case only becomes a failed run through #6.
2. Structured provider errors: keep status, code, `limit_source` and `Retry-After` as fields (pi-ai upstream, or a per-attempt response tap shared with #4). Removes the region-as-key-refused limitation and enables honest rate-limit waits.
3. Trace format v1: version field, generated schema, storage round-trip test for every event kind (including `provider_failover` and `budget_warning`).
4. Land #2 (continue a finished run) with per-continuation budgets and a lease on resume.
5. Land #8, #9, #10 (fence, call cap, graceful finish), then the harness-level `ToolResult.untrusted` flag so fencing does not depend on plugin order, and auto-inject `fence.note()`.
6. Land #3 (record/replay), expose `streamFn` in the facade, publish the failure-injection fake provider.
7. Land #5 and verify the Workers entry in CI; split the `node:fs` imports out of memory and skills.
8. Parallel tool calls with a per-tool concurrency-safe flag.
9. Structured-output repair (JSON repair before a retry turn) and token budget.
10. Balance preflight hook and reasoning tokens in `Usage` (needs pi-ai).

## Open questions for Nik

- A shared (cross-run) provider circuit breaker: only if driven by status-backed structured classifications. Until decided, state is per run.
- Should the harness add `fence.note()` to the system prompt automatically when a fence is configured? Conservative default today: the host does it.
- Facade now depends on `@droveragent/model` (#7) to re-export the chain; acceptable, or keep the chain import separate?
- pi-ai: fork, upstream, or wrap, for structured errors and reasoning tokens.
- Publishing: none of the above has been published; versioning of the new event kinds waits on the trace-format decision.

## What was not verified

Everything about live providers: the chain, adapters and billed cost are tested against local servers that return documented statuses and bodies, not against OpenRouter or the Cloudflare AI Gateway. Workers runtime behaviour (#5) is bundling only. Storage persistence of the new event kinds is not tested. Items marked (read) were read in code but not run.
