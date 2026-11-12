# Changelog

All workspace packages (`@droveragent/*` + the `droveragent` umbrella) version together.

## 0.3.0-next.1

Prerelease on the `next` dist-tag; all @droveragent packages at 0.3.0-next.1.

Every package (`@droveragent/*` and the `droveragent` umbrella) moves to 0.3.0-next.1 together, from 0.1.0 / 0.1.1 / 0.2.0, re-aligning the lockstep that 0.2.0 broke. `latest` stays on the current releases until 0.3.0.

### Breaking

- `QuotaExceededError.dimension` has a new value, `"tokens"` (the new `quota.maxTokens` budget); an exhaustive `switch` over the dimension needs a case for it (#10, #26).
- `HarnessEvent` has two new kinds, `budget_warning` (#10, #26) and `provider_failover` (#7, #17); an exhaustive `switch` over `event.kind` needs cases for them. Both have a row in trace format v1, so stored traces read them as typed events.
- Behavioural: an answerless final message now fails the run with `ProviderError` instead of ending `success`: `stopReason: "length"` with no tool call or text (thinking only), and an empty completion with zero output tokens or as the run's first assistant message. An empty end after tool work with output tokens stays a success (#6, #16).

### Added

- `createProviderChain` in `@droveragent/model` (`RunOptions.providers` / `HarnessDeps.providers`): an ordered list of pi-ai provider names with failover inside a model call, first call or mid-run, classified status-first from structured fields, never message text; credits, key and region failures bench a provider for the rest of the run, and an exhausted chain ends the run `ProviderError` listing each attempt's class and status (#7, #17).
- `provider_failover` event (`retry` / `failover` / `exhausted`, failure class and status, never provider text); `usage` events carry `provider` and `model`; `RunResult.usageByProvider` splits usage per serving provider (#7, #17).
- `makeSummarizer` takes an optional transport, so under a provider chain the compaction summariser fails over too (#7, #17).
- Structured provider errors: a per-attempt response tap records a failed attempt's status, error code, `limit_source` and allow-listed headers (`Retry-After`, rate-limit ids); a region refusal classifies as `region_refused`, `limit_source: openrouter_key_limit` as credits, and a real `Retry-After` drives the wait; failures are on the final message's `diagnostics`, provider text only with `includeProviderText` (#12, #18).
- `quota.wrapUp` (`{ at?, message? }`), the `budget_warning` event and `RunResult.wrapUp`: once a turn, token, cost or wall-clock budget is `at` spent (default 0.8), every following model call carries an operator notice to finish now without more tools; `RunResult.wrapUp.outcome` says whether the run wrapped up in time or was cut off (#10, #26).
- `quota.maxTokens`, a hard token budget (input, output and cache tokens, checked after each model response); a validated final answer whose own call crosses a cost or token budget wins (`success`, `RunResult.wrapUp.overshoot`) (#10, #26).
- `HarnessDeps.now`, the clock for the wall-clock wrap-up threshold (#10, #26).
- `HarnessPlugin.beforeModelCall` (`@droveragent/core`): admission control before every model call of a run (first, later and the `postSuccess` continuation), ahead of compaction; a refusal ends the run `error` with the plugin's tag and message, the refused call is never sent and adds no usage, turn or checkpoint, and a hook that throws or dies fails open (#14, #28).
- `balancePreflightPlugin` and `openRouterBalance` (`@droveragent/plugins`): refuse a run, or a later call every N calls, when a provider balance is below the estimate plus a reserve; `onUnknown: "allow" | "refuse"` for an unreadable balance or estimate; the message states balance, needed, estimate, spent and reserve (#14, #28).
- `toolCallCapPlugin({ maxCalls, perTool, message, warnAt })` (`@droveragent/plugins`): a tool call over a cap is refused with a tool error the model can act on instead of ending the run, the model is warned once at 80% of each cap, and `usage(runId)` exposes the counts, kept across pause and resume (#9, #25).
- Trace format v1 (`@droveragent/core`): `TRACE_VERSION`, `REQUIRED_FIELDS` exhaustive over event kinds, a tolerant `readEvent`, `traceToJsonl` / `parseTraceJsonl`, `summarizeTrace`, and storage round-trip tests for every kind on both adapters; see `docs/reference/trace-format.mdx` (#13, #27).
- `UNTRUSTED_FIELDS` marks the trace fields that hold model, tool, user or memory text; `tool_call_end.trust` is a trust hint stamped `untrusted`; `traceToJsonl` escapes HTML-unsafe characters and takes a `redact` hook (`remove` / `mask`) (#13, #27).
- `@droveragent/facade/core`, a Worker-friendly entry: `runAgent` / `resumeAgent` with no static just-bash or `node:fs` import, `sandbox` required (an adapter or `"disabled"`: no filesystem, no shell), `cwd` / `env` defaulting to `"/"` / `{}`; `createDisabledSandbox()` from both entries; guide `docs/guides/workers.mdx` (#5, #24).
- `@droveragent/eval`: `recordStream` and `replayStream` record provider responses and replay them offline through `streamFn` (keyed by conversation and call, so parallel subagents replay in any order; a request that matches no turn fails with `ReplayDriftError`), and `fakeProvider(script)` with faults (402, 403, 429 with `Retry-After`, 5xx, timeout, empty completion) for tests (#3, #22).
- `@droveragent/sandbox`: `sandboxConformanceCases` and `runSandboxConformance`, a shared, test-framework-agnostic SandboxAdapter conformance suite for adapter authors (#42, #33), run against `none`, just-bash, Vercel and Cloudflare (#55, #41).
- Every package ships the MIT licence and carries `license`, `repository` (with `directory`), `homepage` and `bugs` in its manifest; the repository has `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md` (including how to develop a consumer against a local build), and issue and PR templates (#40, #32, #38).
- Repository: CI on every PR and `main` push (`scripts/ci.ts` gates: lint, changed-file format, build, typecheck, pack check, tests) (#35, #30).
- Repository: tag-triggered release workflow with npm provenance behind an approval, `next` dist-tag for prereleases, lockstep `scripts/release-bump.ts`, and `RELEASING.md` (#36, #31); re-runs clear a prerelease left on `latest` and detect a first publish from `npm view <pkg> versions` (#51, #39).
- `createFence()` in `@droveragent/core` and `untrustedResultsPlugin` in `@droveragent/plugins`: untrusted data, fail closed. Every tool result is fenced (per-run nonce, NFKC, look-alike and invisible-character cleaning, tag escaping, bounds) unless the tool is on one `trusted` allowlist (`task`, `recall`, `show_tool_result`, `skill_load`, `skill_resource` can never be); so are stored copies by their own provenance, the compaction summary, untrusted memory entries, subagent results and lifecycle `mcp` / `skill` output. The fence is applied outermost and last whatever the plugin order, the plugin injects its own system-prompt note, and a resume whose nonce is lost is refused (`HarnessPlugin.assertResumable`). See `docs/guides/untrusted-data.mdx` (#8, #19).
- New plugin hooks `systemPromptAddendum`, `wrapUntrusted`, `inheritToSubagents`, `assertResumable`; `MemoryEntry.trusted`; truncate store provenance and collision-safe handles (`TruncateStore.set` returns a handle; additive) (#8, #19).

### Changed

- The memory, skills, commands and prompt file loaders import `node:fs/promises` on first use instead of at module load; no API change (#5, #24).
- MCP tool descriptions are cleaned and capped at 500 characters, and input schemas pass a JSON Schema keyword allowlist (no `pattern`, identifier-like names, token-like enum values); a tool with an unsafe name or schema is refused and logged, and `McpRuntime.callTool` only calls offered tools. Some MCP tools that used to load are now skipped (#8, #19).
- Markdown memory ignores `trusted: true` in frontmatter unless `allowTrustedFrontmatter: true` (#8, #19).
- Response tap: kept provider header values must be plain characters or are dropped, the tap tags a request only while it is the global `fetch`, and the error-body read is capped in bytes (#58, #48).

### Fixed

- A provider failure is never a success: an HTTP error reported by pi as `stopReason: "error"` (main loop or `postSuccess`) ends the run `error` with `ProviderError`, a status-only message and a numeric `error.status`, and an `error` event before `run_end`; a failed compaction summary call is a `CompactionError` that keeps the history; raw provider text stays out of results, events, the run row and checkpoints unless `includeProviderErrorText: true` (#6, #16).
- A model whose provider is not in the chain (for example a cheaper `compaction.summaryModel`) goes straight to pi-ai instead of failing with "no provider can serve model", and a caller abort during an attempt ends `aborted`, not `error` (#47, #44).
- `none` sandbox: a timeout or abort kills the whole process tree (no hang while a grandchild holds the pipe); an already-aborted signal resolves `killed: true`; an exec still running when the host exits or receives SIGINT, SIGTERM or SIGHUP is killed with it, while the host keeps its own exit status or handler. Process groups are POSIX-only (#42, #33).
- `@droveragent/sandbox-vercel`, `@droveragent/sandbox-cloudflare`: `writeFile` creates missing parent directories (one `mkdir -p` and a retry after a failed write), as the conformance suite requires (#55, #41).
- `@droveragent/eval` replay: a recorded call that cannot be hashed no longer marks later calls concurrent, and ambiguity is judged only on the matching turns, ignoring `timestamp` and `responseId` (#60, #22).

## 0.2.0 — 2026-08-25

`@droveragent/harness` + `@droveragent/facade` only; every other package is
unchanged at 0.1.x.

### Added

- `RunOptions.onPayload` (facade) / `HarnessDeps.onPayload` (harness) — patch the
  provider request body immediately before it is sent. pi calls it with the
  built params and the model; return the replacement payload, or `undefined` to
  leave it unchanged.

  The seam is for provider request preferences the host knows and the harness
  does not — OpenRouter routing being the motivating case:

  ```ts
  runAgent(spec, input, {
    onPayload: (payload) => ({
      ...(payload as Record<string, unknown>),
      provider: { order: ["amazon-bedrock/us-east-1"], allow_fallbacks: true },
    }),
  });
  ```

  Applied to EVERY model call of the run — the main loop, subagent runs (which
  inherit `deps`), and the compaction summariser — so a pinned route stays
  pinned for the whole run. Never carry secrets in it: this is the request body,
  not a credential channel; use `apiKey` or an egress proxy.

  Previously `loopConfig` was a fixed literal that never forwarded `onPayload`,
  so a consumer had no way to reach it short of replacing the whole transport
  via `HarnessDeps.streamFn`.

## 0.1.0 — 2026-08-01

First consumer-ready release.

### Added

- `RunOptions.models` — inject pre-resolved pi-ai models (+ API keys) keyed by
  spec model name; checked before alias/slug/builtin lookup, bypasses env-var
  key reading. `PreResolvedModel` re-exported from the facade.
- Opt-in token-delta streaming: `RunOptions.emitDeltas` forwards pi
  `message_update` deltas as new `assistant_delta` / `thinking_delta`
  `HarnessEvent` variants. Default off — the event stream is unchanged.
  Deltas are ephemeral (never persisted to storage); whole-message
  `assistant_text` / `thinking` remain the durable record. Tool-call
  argument deltas stay dropped.
- `HarnessDeps.streamFn` — pi transport override seam, forwarded verbatim to
  `runAgentLoop`/`runAgentLoopContinue` (host proxies, offline tests).

### Fixed

- `resolveModel` fails fast with a typed `ModelError` (`reason: "routing_miss"`)
  when a well-formed slug names a model missing from pi-ai's table — pi-ai's
  `getModel()` returns `undefined` instead of throwing, which previously
  yielded `ResolvedModel.model === undefined` and an obscure crash inside the
  loop.

### Changed

- `@mariozechner/pi-ai` + `@mariozechner/pi-agent-core` 0.70.6 → 0.73.1.
- `scripts/publish-all.sh` is fail-fast: the first publish failure aborts the
  release (no silent per-package swallow); a package is skipped only when that
  exact version is already on the registry.

## 0.0.2 — 2026-05-31

- Auto + manual history compaction primitives.
- `droveragent` umbrella package re-exporting facade + `defineAgent`.
- tsc dist build + publish config for all packages.
- npm scope rename `@drover` → `@droveragent`.

## 0.0.1 — 2026-05

- Initial release: Effect-native harness on pi-agent-core, TypeBox agent
  specs, Promise/AsyncIterable facade, plugins, skills, memory, MCP,
  sandboxes, storage, runtime queue, evals.
