# Drover as an agent primitive framework: assessment and roadmap

Status: proposal. Audience: Drover maintainers. Tracking epic: #15. Refresh history:

- written 2026-11-11 against `main` (04e87fb);
- refreshed 2026-11-12 against `main` (fa67a59) after the first merges;
- refreshed again 2026-11-12 against `main` (2e590cf), after the overnight merges and two prereleases, `0.3.0-next.1` and `0.3.0-next.2`.

Goal: Drover should be a very capable agent primitive framework: small, typed pieces that compose, each with a clear contract, none of them an opinionated agent. This document assesses it primitive by primitive. "Exists" means found in the code at the path given. Items marked (read) were checked by reading code, not by running it.

## Releases

Both are prereleases on the `next` dist-tag, published from tags by the release workflow with provenance. `latest` is unchanged. All 19 `@droveragent/*` packages move in lockstep. The unscoped `droveragent` umbrella is private and unpublished (#68): npm refused the name.

| Release        | Tag       | Contents (PRs)                                                                                    |
| -------------- | --------- | ------------------------------------------------------------------------------------------------- |
| `0.3.0-next.1` | `534c80d` | #6, #7, #13, #42, #35, #36, #40, #9, #12, #5, #51, #3, #55, #10, #58, #8, #60, #47                |
| `0.3.0-next.2` | `2e590cf` | #50, #2, #57, #64, #68, #4, #70, and the bundle #73 (#63, #52, #54, #66, #71, #14, #72, #67, #56) |

Known issue in `0.3.0-next.2`: an Azure or Bedrock chain entry can be redirected by process env (`AZURE_OPENAI_BASE_URL`, `AWS_REGION`). The fix is #76, for `next.3`. OpenRouter and the Cloudflare AI Gateway are unaffected.

## Status of the PRs this roadmap tracks

| PR       | Issue    | What                                                                                                                        | State (2026-11-12) |
| -------- | -------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| #6       | #16      | provider errors and empty completions fail the run                                                                          | merged, next.1     |
| #7       | #17      | provider chain with classified failover, `provider_failover` event, usage per provider                                      | merged, next.1     |
| #13      | #27      | trace format v1: versioned schema, tolerant reader, JSONL, summary, storage round trip, untrusted-field marks and redaction | merged, next.1     |
| #42, #55 | #33, #41 | shared `SandboxAdapter` conformance suite, run on `none`, just-bash, Vercel and Cloudflare; `none` kills process trees      | merged, next.1     |
| #35, #36 | #30, #31 | CI on every PR and `main`; tag-triggered release with provenance, lockstep bump                                             | merged, next.1     |
| #51      | #39      | release re-runs: a prerelease left on `latest` is cleared; first publish detected from `npm view`                           | merged, next.1     |
| #40      | #32      | MIT licence, `SECURITY.md`, `CONTRIBUTING.md`, README, templates                                                            | merged, next.1     |
| #8       | #19      | untrusted-data fence, fail closed (`createFence`, `untrustedResultsPlugin`)                                                 | merged, next.1     |
| #64      | #45      | fence hardening: live-safe nonce store, per-call result strings, MCP schema budgets, `onRunEnd` on every exit               | merged, next.2     |
| #66      | #21      | untrusted `appendMessages` items fenced                                                                                     | merged, next.2     |
| #77      | #21      | #66 nits: PluginError names the fence that threw, `warning` event for an unfenced untrusted item                            | draft, in review   |
| #9       | #25      | `toolCallCapPlugin` (caps, near-cap warning, `usage(runId)`)                                                                | merged, next.1     |
| #57      | #37      | `repeatRefusalPlugin` and structured deny codes                                                                             | merged, next.2     |
| #5       | #24      | `@droveragent/facade/core` Worker-friendly entry                                                                            | merged, next.1     |
| #70      | #69      | `@opentelemetry/api` dependency so Worker bundles resolve                                                                   | merged, next.2     |
| #14      | #28      | `beforeModelCall` hook and host-level balance preflight                                                                     | merged, next.2     |
| #67      | #49      | balance capability on chain providers; OpenRouter `credits` or `key` mode                                                   | merged, next.2     |
| #2       | #21      | continue a finished run (`resumeAgent` with `appendMessages`), `usageDelta`, per-invocation `budget`                        | merged, next.2     |
| #3, #60  | #22      | eval record and replay of provider responses via `streamFn`; `fakeProvider` with faults                                     | merged, next.1     |
| #4       | #23      | `withProviderCost`: provider-billed cost as `Usage.costUsd`                                                                 | merged, next.2     |
| #10      | #26      | `quota.wrapUp` graceful finish; `quota.maxTokens`                                                                           | merged, next.1     |
| #50      |          | `maxTurns` is a budget: a validated answer on the last turn ends `success`                                                  | merged, next.2     |
| #71      | #62      | budget-forgiveness follow-ups: provider error on a forgiven breach; invocation budget follows the answer-wins rule          | merged, next.2     |
| #12, #58 | #18, #48 | structured provider errors via a per-attempt response tap; plain header values, byte-capped body                            | merged, next.1     |
| #72      | #59      | per-header value shapes for kept provider headers                                                                           | merged, next.2     |
| #47      | #44      | provider chain routes models whose provider is not in the chain                                                             | merged, next.1     |
| #63      | #53      | per-class failover actions (`stop`, `next`, `skip`), `benched` flag                                                         | merged, next.2     |
| (bundle) | #52      | per-run provider chain record (`RunResult.chainRecord`, `chain_record` trace event)                                         | merged, next.2     |
| (bundle) | #54      | chain providers as settings (key, base URL vars, headers, models per entry); env only as fallback                           | merged, next.2     |
| #76      | #74      | chain entry base URLs for Azure and Bedrock not redirected by process env                                                   | draft, for next.3  |
| #56      | #38      | `droverVersions()` and a per-package build version stamp                                                                    | merged, next.2     |

## Summary

Drover is strongest where the loop is: declarative specs, plugins, durable pause/resume and continuation, compaction, subagents, MCP, sandboxes, skills, memory. Overnight the production gaps this roadmap ranked first were closed and shipped in two prereleases:

- a provider failure is a failed run (#6);
- a run fails over between providers with per-class actions and a per-run record (#7, #63, #52), and chain providers are configured as settings (#54);
- untrusted data is fenced, fail closed (#8, #64, #66);
- a run finishes inside its budgets (#10, #50, #71), and admission control runs before each call (#14, #67);
- a finished run can be continued with its own budget (#2);
- provider responses can be recorded and replayed (#3).

What remains is the structural follow-up to the fence (#20, provenance on the data), a lease on continuation (#21), a real Workers runtime test (#46), parallel tools and output repair (#29), and live verification against real providers. Each of the first four has a design decision waiting (see Open questions).

## Primitive by primitive

### 1. Model and provider abstraction

- Exists:
  - `packages/model`: alias resolution, `ModelSpec`, per-provider env keys, `preResolved` models, with pi-ai underneath;
  - the `HarnessDeps.streamFn` and `onPayload` seams, and `cacheRetention`;
  - `createProviderChain`:
    - ordered providers, with classified failover inside a call (status first, structured fields only);
    - per-class `actions` (#63);
    - models outside the chain go straight to pi-ai (#47);
    - a per-run chain record (#52);
    - providers configured as settings, with env only as a fallback (#54).
  - Structured provider errors through a per-attempt response tap (#12). It keeps plain, per-header-shaped values only (#58, #72).
  - Provider-billed cost on OpenRouter (#4).
- Missing:
  - pi-ai still flattens errors and drops headers, so the tap is a workaround;
  - rate-limit awareness beyond one `Retry-After` wait;
  - reasoning tokens in `Usage` (#43);
  - Azure and Bedrock entries pinned against process env (#76).
- Smallest next step: land #76; then decide whether to push structured errors and reasoning tokens upstream into pi-ai.
- Security note, applies to every classifier: provider error text echoes request content, which can contain outside text. Never classify from message text; status first, structured fields only, state scoped to one run.

### 2. Tools: schemas, validation, errors, parallel calls, call caps

- Exists:
  - TypeBox tool definitions with input decode;
  - tool errors returned as `is_error`;
  - `beforeToolCall` allow/deny, with an optional structured deny `code` reported as `tool_call_end.result.denied` (#57);
  - `wrapTool`, per-tool `timeoutMs`, the truncate plugin with `show_tool_result`, dedup, loop-detect;
  - `toolCallCapPlugin` (#9);
  - `repeatRefusalPlugin`, which answers a resend of a failed call without running it and forgets failures after a successful destructive call (#57).
- Missing:
  - parallel tool calls: the loop runs `toolExecution: "sequential"` (read);
  - output schemas for tools;
  - per-tool retry.
- Smallest next step: #29 as decided overnight. Parallel calls are opt-in per tool, with a spec-level `toolExecution.parallel` limit; the default stays sequential.

### 3. Structured output with repair

- Exists: `outputSchema`, `outputRetries` self-correction with `output_retry` events, `outputValidatePlugin`.
- Missing: JSON repair before spending a retry turn; provider-native structured output as an option.
- Smallest next step: #29 as decided overnight. A syntactic-only `repairJson` step in front of decode, opt-in through `outputRepair` (default off; consider flipping it on at `0.3.0`), with a counter in the event.

### 4. Budgets: turns, tokens, cost, wall clock, graceful finish

- Exists:
  - `quota.maxTurns|maxTokens|maxCostUsd|maxDurationMs`, `QuotaExceededError`, the `quota` status.
  - `quota.wrapUp`: an operator notice once a budget is `at` spent, plus a `budget_warning` event and `RunResult.wrapUp` (#10).
  - "The answer wins over its own breach":
    - `maxTurns` always (#50);
    - cost and tokens once the warning fired, recorded as `wrapUp.overshoot` with its `scope`;
    - a provider error on that call stays `ProviderError` (#71).
  - The per-invocation `budget` for resumes and continuations, under the same rule (#2, #71).
  - Billed cost on OpenRouter (#4).
  - Admission control before each model call (`beforeModelCall`, #14).
- Missing: per-child budgets carved from the parent's; billed cost for providers other than OpenRouter.
- Smallest next step: a child budget slice (see Subagents).

### 5. Context management and compaction

- Exists:
  - the compaction ladder (`packages/harness/src/compaction`, `design/compaction.md`), with manual and auto triggers;
  - checkpoints store the compacted history, and `beforeCompaction` is available;
  - the summariser goes through the chain's transport under a chain (`makeSummarizer` takes a transport);
  - a cheaper `summaryModel` outside the chain goes to pi-ai (#47);
  - the summary is fenced as untrusted (#8).
- Missing: the summariser still ignores a bare `streamFn` without a chain (read); token counting is an estimate; no cache-aware compaction.
- Smallest next step: route the summariser through `streamFn` always; measure cache loss from a pass.

### 6. Memory

- Exists:
  - `packages/memory`: adapter, markdown store, BM25 recall, `remember`/`recall`/`forget`, rate limit;
  - `MemoryEntry.trusted` (#8): untrusted index entries and `recall` are fenced, and frontmatter `trusted` is ignored unless `allowTrustedFrontmatter`;
  - lazy `node:fs` in the loaders (#5).
- Missing: embeddings-based recall (a dependency decision); a durable memory adapter for Workers (D1 or KV); which run wrote an entry.
- Smallest next step: record the writing run id on entries.

### 7. Skills

- Exists: `packages/skills` (`SKILL.md` loader, `skill_load`, `skill_resource`, allowlist, progressive disclosure). Skill output and lifecycle `skill` steps are fenced (#8).
- Missing: version in the spec hash beyond file content; a skills eval.
- Smallest next step: include skill name and version in `hashSpec`.

### 8. Subagents

- Exists:
  - `taskTool`, depth and fan-out caps, child lifecycle events;
  - children inherit `deps`, so a provider chain applies;
  - the fence plugin is inherited by every child, with its own nonce, and `task` results are fenced in the parent (#8);
  - replay keys by conversation and call, so parallel children replay in any order (#3, #60).
- Missing: per-child budgets carved from the parent's; result schemas for children. The tool-call cap, the repeat guard and the balance preflight apply to a child only if its own spec carries them.
- Smallest next step: a child budget slice (`quota` as a fraction of the parent's remaining).

### 9. Human approval and permission hooks

- Exists: `confirmGatePlugin`, `writePolicyPlugin`, `bashBlocklistPlugin`, `beforeToolCall` deny with a structured `code` (#57), pause/resume, `beforeModelCall` refusal (#14).
- Missing: input rewriting in `beforeToolCall` (documented as planned), a typed approval record in the trace, timeouts on pending approvals.
- Smallest next step: the approval decision (who, when, what) as an event.

### 10. Untrusted-data handling as a first-class primitive

- Exists:
  - Trace format v1 marks untrusted fields, with a `trust` hint, HTML-safe JSONL and a redaction hook (#13).
  - `createFence()` and `untrustedResultsPlugin` (#8):
    - every tool result is fenced unless the tool is on one `trusted` allowlist;
    - so are stored copies, the compaction summary, untrusted memory, subagent results, and lifecycle `mcp` / `skill` output;
    - it is applied outermost and last;
    - a resume whose nonce is lost is refused.
  - Hardening (#64):
    - a nonce store that never evicts a live run;
    - exact produced strings kept per tool call;
    - `onRunEnd` on every exit, so early failures free per-run state;
    - MCP schema budgets, a `format` allowlist and `required` filtering.
  - Untrusted `appendMessages` items fenced after `assertResumable` (#66). The nits are in #77: the error names the throwing fence, and a `warning` event fires when nothing fences.
- Provenance rule (the invariant to keep): **anything a tool returns is untrusted unless positively marked trusted, and the mark is stored with the data it describes. Fail closed.** Fence by provenance, never by content; "already fenced" is never inferred from text.
- Missing:
  - provenance on the data itself, so fencing does not depend on a plugin's side tables (#20, design waiting: A1 to D1 below);
  - a durable `NonceStore` example for cross-process resume.
- Smallest next step: decide #20, then implement it. D1 replaces the per-call string bookkeeping that every review round of #8 had to patch.

### 11. Durable and resumable runs

- Exists:
  - checkpoints per turn, the `paused` status, `resumeAgent` with spec id and hash validation;
  - libsql, memory and D1 storage, and a runtime queue with leases and crash recovery;
  - continuing a finished run with `appendMessages`, its own `budget` and `usageDelta` (#2);
  - turn checkpoints ordered and awaited before the final one (#2);
  - a run that fails before the loop now gets a terminal row status (#64).
- Missing:
  - a lease against concurrent continuations (#21, design waiting). Concurrent continuations corrupt the stored run, and a crashed holder leaves it `running` forever;
  - idempotent tool side effects across resume.
- Smallest next step: decide the #21 lease option, then implement it on libsql and D1.

### 12. Streaming

- Exists: `HarnessEvent` stream as `AsyncIterable`, opt-in `assistant_delta` and `thinking_delta`.
- Missing: tool-call argument deltas (dropped by design), backpressure contract, SSE/HTTP adapter (out of scope in `CLAUDE.md`).
- Smallest next step: none urgent.

### 13. MCP client

- Exists:
  - `packages/mcp`: stdio and HTTP transports, `<server>__<tool>` prefixing, a per-agent allowlist, runtime lifecycle;
  - results fenced by default; descriptions cleaned and capped;
  - input schemas reduced to a keyword allowlist with identifier-like names and token-like enum values (#8);
  - per-tool budgets: enum/const/default text 2048 chars, prose and names 4096 chars;
  - only known `format` names kept, and `required` filtered to real properties (#64);
  - unsafe tools refused, and `callTool` only reaches offered tools.
- Missing: auth flows for remote servers; resource and prompt support (read).
- Smallest next step: none urgent.

### 14. Sandboxes

- Exists:
  - `SandboxAdapter`, with `none`, just-bash (the default), Vercel and Cloudflare adapters;
  - a shared conformance suite run against all four (#42, #55); `writeFile` creates missing parents;
  - `none` kills the whole process tree on timeout, abort and host exit or signal.
- Missing: resource limits as part of the contract.
- Smallest next step: none urgent.

### 15. Tracing with a stable trace format

- Exists:
  - trace format v1 (`packages/core/src/trace.ts`, #13): `TRACE_VERSION`, `REQUIRED_FIELDS` exhaustive over event kinds;
  - a tolerant reader, JSONL export, `summarizeTrace`, and a storage round trip for every kind;
  - rows for `provider_failover`, `budget_warning` and `chain_record`;
  - `toolCalls.repeatedFailures` in the summary (#57).
- Missing: the `warning` row (with #77); reasoning tokens (#43); an OTel exporter (declared out of scope, kept as a clean slot).
- Smallest next step: land #77.

### 16. Evals with record and replay

- Exists:
  - the in-repo suite (`evals/run.ts`, scenarios, fixtures) and the eval-viewer app;
  - `@droveragent/eval`: `recordStream` / `replayStream` (keyed by conversation and call, with `ReplayDriftError`) and `fakeProvider` with faults (402, 403, 429 with `Retry-After`, 5xx, timeout, empty completion) (#3, #60);
  - `RunOptions.streamFn` in the facade (#4).
- Missing: reusable `ScenarioRunner`, `Scorer` and `Reporter`.
- Smallest next step: a `ScenarioRunner` over `replayStream`.

### 17. Runtime targets and bundle size

- Exists:
  - Bun and Node;
  - `@droveragent/facade/core` (#5): about 2.1 MB minified with every provider, guarded by a test against Node-only imports and size;
  - `sandbox: "disabled"` and a Workers guide;
  - Worker bundles resolve `@opentelemetry/api` (#70).
- Missing:
  - a run on the Workers runtime in CI (#46, decision waiting on the Miniflare dependency). pi-ai's computed `node:` imports at module load are invisible to the bundle guard, so only workerd catches them;
  - a durable Workers memory adapter.
- Smallest next step: decide #46, then the workerd test.

### 18. Balance preflight

- Exists:
  - `beforeModelCall` admission control and `balancePreflightPlugin` (#14);
  - a chain-carried `balances` map read through `balanceSources()` (#67);
  - `openRouterBalance` in `credits` (`/credits`, may need a management key) or `key` (`/key` `limit_remaining`) mode.
  - A refused call is never sent and adds no usage, turn or checkpoint. A refused run ends `error`, and `resumeAgent` refuses `error` runs, so a host starts a new run after a top-up.
- Missing: the OpenRouter source checked once against the live API (#49's live criterion stays open).
- Smallest next step: one live check with a real key.

## Ranked next ten changes

1. Decisions from Nik: #20 provenance (A1 to D1), the #21 lease option, the #46 Miniflare dependency, and the umbrella name. Each unblocks one item below.
2. Land #76 (Azure and Bedrock base URLs) and #77 (fence nits); release `0.3.0-next.3`.
3. #20 provenance on the data, as decided. D1, the harness fencing as the last step, is the structural fix for the class of bugs #8's review rounds kept finding.
4. #21 lease on continuation (libsql and D1), with expiry, so a crashed holder is reclaimed.
5. #29 parallel tool calls (opt-in per tool, spec limit) and syntactic output repair (opt-in), as decided overnight.
6. #46 workerd run of the core entry in CI.
7. Live verification: the Cloudflare AI Gateway leg of #17, OpenRouter `/credits` and `/key` (#49), and billed cost (#4).
8. pi-ai: structured errors and reasoning tokens upstream (#12 wraps today, #43).
9. Child budget slices and result schemas for subagents.
10. Release hygiene: trusted publishers per package, then remove `NPM_TOKEN`; branch protection on `main` requiring `ci`; approve release plan #34 for `0.3.0`.

## Open questions for Nik

- A shared (cross-run) provider circuit breaker: only if driven by status-backed structured classifications. Until decided, state is per run.
- Should the harness add the fence note to the system prompt itself when a fence is configured? Today the fence plugin injects it through `systemPromptAddendum`, so a host using the plugin gets it; a host fencing by hand still adds it.
- The facade depends on `@droveragent/model` to re-export the chain. Acceptable, or keep the chain import separate?
- pi-ai: fork, upstream, or wrap, for structured errors (#12 wraps) and reasoning tokens (#43).
- Publishing: `0.3.0-next.1` and `0.3.0-next.2` went out from tags, approval-gated, with the `NPM_TOKEN` you provided. Move to trusted publishing per package and delete the token? Approve the release plan (#34) for `0.3.0` on `latest`?
- #21 lease against concurrent continuations. Concurrent continuations corrupt the stored run (interleaved event seqs, mixed checkpoints), and a crashed holder leaves the run `running`. Options:
  - A: required `claimRun` plus lease columns (breaking for adapters);
  - B, recommended: optional `claimRun?` / `renewLease` with `lease_owner` / `lease_until` columns in libsql and D1. A continuation is refused on adapters without it unless `unsafeConcurrentContinue`. Additive;
  - C: status-only compare-and-set (no migration, but a crash wedges the run);
  - D: an in-process mutex only.
- #20 provenance design. All four are recommended; approve A1, B1, C1 and D1?
  - A1: the harness owns the trust list (`HarnessDeps.trustedTools`, `NEVER_TRUSTED` enforced in the harness; the plugin only reads it).
  - B1: provenance persisted on `tool_call_end` and on checkpoint tool messages (no migration; a legacy record is untrusted).
  - C1: one `Provenance` type and `leastTrusted()` for summaries, memory, `task` results and appended messages.
  - D1: the harness fences untrusted results as the last step, after every `afterToolCall`. It removes the plugin's per-call string records and the re-fence step. It is the big one: it reorders #8's rules.
- Umbrella package name. npm refuses the unscoped `droveragent` (too similar to `drover-agent`), and it is private meanwhile. Options: `@droveragent/droveragent`, `@droveragent/all`, ask npm support for the name, or drop the umbrella.
- #46: add `miniflare` (workerd, about 100 MB native binary) as a devDependency for a real Workers CI run of `facade/core`, or run it as a separate optional CI job? The entry is bundling-verified only.
- #29 decisions taken overnight (conservative; confirm or reverse):
  - parallel tool calls are opt-in per tool plus a `spec.toolExecution.parallel` limit, and the default stays sequential;
  - JSON repair is syntactic only and opt-in (`outputRepair`, default off); flip it on at `0.3.0`?
  - The token budget and bounded output retries in #29's scope already exist (#10, `outputRetries`).

## What was not verified

Everything about live providers:

- The chain (beyond a partial OpenRouter-to-OpenRouter proof on #17), billed cost and the OpenRouter balance sources are tested against local servers or an injected `fetch` with documented statuses and bodies. None were run against OpenRouter or the Cloudflare AI Gateway.
- The Workers entry is verified by bundling only (#46 is the runtime test).
- Items marked (read) were read in code but not run.
