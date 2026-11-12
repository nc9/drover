# Changelog

All workspace packages (`@droveragent/*` + the `droveragent` umbrella) version together.

## 0.3.0-next.3

Prerelease on the `next` dist-tag; all @droveragent packages at 0.3.0-next.3, including the umbrella, which publishes for the first time as `@droveragent/all`.

### Breaking

- `HarnessEvent` has a new kind, `warning` (`code`, `message`, `count`); an exhaustive `switch` over `event.kind` needs a case for it. It has a row in trace format v1 (#77, #21).
- `HarnessError` has a new member, `SpecConfigError`, for an invalid spec setting or run option: a `toolExecution.parallel` that is not an integer >= 1 (#79, #29), or a `providers` value that is not a provider chain (#83, #81). An exhaustive `switch` over the error tag needs a case for it. Both are caught at run start, before any model call.
- Behavioural: a `providers` run option must be a chain from `createProviderChain({ providers: [...] })`. A hand-built `{ forRun, preResolvedModels }` object (accepted in 0.3.0-next.1, and hanging the run in 0.3.0-next.2) now fails with `SpecConfigError` naming the option (#83, #81).
- Behavioural: `amazon-bedrock` chain entries pointing at a FIPS endpoint (`bedrock-runtime-fips.<region>...`) are refused, because pi-ai does not forward `useFipsEndpoint` and the call would silently go to the non-FIPS endpoint. A Bedrock entry with `useEnv: false` and no `apiKey` is refused, because IAM credentials come from the AWS SDK's environment chain; so is one with `useEnv: false` and a custom endpoint that names no region (#76, #74).

### Added

- Parallel tool calls: `spec.toolExecution.parallel` (an integer; default off, one call at a time) runs up to that many `concurrency: "safe"` calls of one model turn at once. Results reach the model in call order, a failure in one call does not cancel the others, and one unsafe call makes its turn sequential. Safe built-ins: `read`, `ls`, `grep`, `find`, `recall`, `skill_load`, `skill_resource`, `show_tool_result`. New `ToolDef.concurrency` and `McpServerConfig.concurrencySafe` (`true` or a list of tool names; MCP tools are sequential by default). `tool_call_end` events of a parallel turn arrive in completion order (#79, #29).
- `outputRepair: true` (opt-in, default off): before an answer whose JSON does not parse costs a retry turn, it gets one conservative syntactic repair (byte-order mark, comments, trailing commas, typographic quotes, outside strings only; never truncation). `output_validated.repaired: true` marks a repaired answer, and `repairJson(text)` is exported from `@droveragent/harness` (#80, #29).
- `warning` event `untrusted_unfenced`: untrusted `appendMessages` items went in as written because no fencing plugin is on the run (#77, #21).
- `streamIdleTimeoutMs` on `RunOptions` / `HarnessDeps` and `createProviderChain`: a model call whose stream yields no event for this long (default 10 minutes; 0 turns it off) ends as a provider failure; in a chain it is a `timeout` that fails over. The compaction summariser and models outside a chain are watched too. `withStreamIdleTimeout` is exported from `@droveragent/model`. A model that reasons silently for longer than the limit times out, so raise it for such models (#83, #81).
- `ProviderEntry.region` for `amazon-bedrock`: picks the runtime endpoint and the request region (default `AWS_REGION` / `AWS_DEFAULT_REGION` from the entry's environment) (#76, #74).

### Changed

- The umbrella package publishes as `@droveragent/all` (npm refused the unscoped `droveragent` name); install `@droveragent/all@next`, or the scoped `@droveragent/facade` and `@droveragent/core` (#85).
- `amazon-bedrock` chain entries: `apiKey` is the Bedrock API key, sent as the bearer token; without one (and with the environment allowed) the AWS SDK's default credentials apply. Without a region, the region the endpoint names is pinned, never `process.env.AWS_REGION`. A model declared in `models` needs a `region` or `baseUrl` (#76, #74).
- `azure-openai-responses` chain entries take the base URL from `baseUrl`, or from `AZURE_OPENAI_BASE_URL` / `AZURE_OPENAI_RESOURCE_NAME` in the entry's environment (not with `useEnv: false`); without one the provider is refused, naming what to set. With `useEnv: false` the API version and deployment name are pinned too (#76, #74).
- With parallel tool calls, a call still waiting for a slot when the run is aborted is not executed, and `toolExecution: { parallel: 1 }` hashes like no setting (#84, #82).

### Fixed

- Azure and Bedrock chain entries in 0.3.0-next.2 could send the call somewhere other than the entry said: pi-ai's simple stream dropped the pinned Azure base URL and the Bedrock region and bearer token, then read `process.env` (`AZURE_OPENAI_BASE_URL` / `AZURE_OPENAI_RESOURCE_NAME`, `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`) instead, even with `useEnv: false`. An Azure entry with `baseUrl` could reach the process-wide Azure host with the entry's key. Azure and Bedrock calls now go through pi-ai's full `stream()` with the entry's settings, and the region is always pinned (#76, #74).
- A `providers` value the facade could not use hung the run until the runtime cancelled it (seen in a Worker). It now fails at run start (see Breaking). An unexpected throw inside a run, or in `resumeAgent` before the run starts, resolves `result` with `error.tag: "InternalError"` and ends the event stream; `result` never rejects. A caller abort ends a model call at once, even if the transport ignores its signal (#83, #81).
- A throwing `wrapUntrusted` on `appendMessages` fails with a `PluginError` naming the plugin that threw, not the first fencing plugin, and leaves the stored run, checkpoint and event log unchanged (#77, #21).

## 0.3.0-next.2

Prerelease on the `next` dist-tag; all published @droveragent packages at 0.3.0-next.2. The `droveragent` umbrella stays private (unpublished).

### Breaking

- `ProviderChainOptions.providers` is widened to `ReadonlyArray<string | ProviderEntry>` (#54): code that reads it back as `string[]` stops compiling. `ProviderChain.providers` (the resolved names) is still `readonly string[]`.
- `HarnessEvent` has a new kind, `chain_record` (#52); an exhaustive `switch` over `event.kind` needs a case for it. It has a row in trace format v1, so stored traces read it as a typed event.
- `readBoundedText`, `readCost` and `attemptTapActive` (response-tap test seams) are no longer exported from `@droveragent/model` (#72, #59).
- Behavioural: more MCP tools are refused. A tool is refused when its `enum` / `const` / `default` text (object keys inside those values included) totals over 2048 characters, or when its description plus the schema's descriptions, titles, property and `$defs` names, `required` entries and `$ref` strings total over 4096 characters (#64, #45).
- Behavioural: `HarnessPlugin.onRunEnd` now fires exactly once on every exit, including a run that fails before the loop (an `init` step, a bad model) or is interrupted. Those runs get a synthetic result: `status: "error"` with the failure's tag, or `"cancelled"` for an interrupt (#64, #45).
- Custom `StorageAdapter` implementations must persist the new `CheckpointRow.usageByProvider`; otherwise `usageByProvider` resets on a continuation instead of staying cumulative (#2, #21).

### Added

- `resumeAgent(spec, runId, { storage, appendMessages })` continues a finished (`success`) run with new user messages. Without `appendMessages` only `paused` runs resume, and spec id and hash checks still apply. `RunResult.usageDelta` is this invocation's usage; `usage` and `usageByProvider` stay cumulative (#2, #21).
- `ResumeOptions.budget` (`InvocationBudget`: `maxTurns`, `maxTokens`, `maxCostUsd`, `maxDurationMs`): a resume or continuation's own budget, counted from where it starts. The spec quota's turns and cost stay cumulative (#2, #21).
- `appendMessages` items can be `{ content, untrusted: true }`. The run's fencing plugins fence them (section `"appended-input"`) after `assertResumable` passes, and a throwing fence ends the call `PluginError`. Adds the `AppendedMessage` type (#66, #21).
- `repeatRefusalPlugin` (`@droveragent/plugins`): a tool call that already failed in the run is answered without running the tool. "The same call" means the same tool and normalised arguments, or a per-tool key. The message tells the model what to do instead. It also has:
  - `retryable` repeats per tool, and `include` / `exclude`;
  - a rule that any successful destructive tool call (`write`, `edit`, `bash`) forgets the run's failures;
  - bounded per-run memory that survives a same-process continuation;
  - `usage(runId)` counters (#57, #37).
- A `ToolDecision` deny takes an optional `code`, reported on `tool_call_end` as `result.denied` (`{ plugin, code? }`). `toolCallCapPlugin` uses `tool_call_cap` and `loopDetectPlugin` uses `loop_detect`. `summarizeTrace` counts `toolCalls.repeatedFailures` (#57, #37).
- `HarnessPlugin.beforeModelCall` (`@droveragent/core`): admission control before every model call of a run (first, later and the `postSuccess` continuation), ahead of compaction. A refusal ends the run `error` with the plugin's tag and message. The refused call is never sent and adds no usage, turn or checkpoint. A hook that throws or dies fails open (#14, #28).
- `balancePreflightPlugin` and `openRouterBalance` (`@droveragent/plugins`): refuse a run, or a later call every N calls, when a provider's balance is below the estimate plus a reserve. `onUnknown: "allow" | "refuse"` handles a balance or estimate that cannot be read. The message states balance, needed, estimate, spent and reserve (#14, #28).
- `createProviderChain({ balances })` and `ProviderChain.balanceSources()` (`@droveragent/model`): an optional balance source per provider, listed in chain order; `balancePreflightPlugin({ sources: chain })` reads them. `BalanceSource` now lives in `@droveragent/core`, re-exported from plugins (#67, #49).
- `openRouterBalance({ mode: "key" })` reads the key's remaining limit (`GET /key`). `"credits"`, the default, keeps the account balance (#67, #49).
- `withProviderCost(base?)` and the provider chain's `billedCost: true` use OpenRouter's billed `usage.cost` as each call's cost. `Usage.costUsd`, `usageByProvider` and `quota.maxCostUsd` then run on billed cost, which replaces the list-price total rather than adding to it. OpenRouter only. `withProviderCost` is in `@droveragent/model`, re-exported by harness and facade. `RunOptions.streamFn` / `ResumeOptions.streamFn` expose the transport seam (#4, #23).
- Provider chain `actions`: per failure class, `"stop"`, `"next"` (fail over for this call only) or `"skip"` (fail over and skip the provider for the run). Defaults are unchanged. `provider_failover` notices and events, and the final error's diagnostics, carry `benched` (skipped for the run, or this call only) (#63, #53).
- `RunResult.wrapUp.overshoot.scope` (`"spec"` or `"budget"`) says which limit a forgiven overshoot crossed (#71, #62).
- `HarnessPlugin.afterToolCall` receives `meta.toolUseId`; `UntrustedResultsPlugin` gains diagnostics `pendingCalls(runId)` and `liveRuns()` (#64, #45).
- `RunResult.chainRecord` and the `chain_record` trace event: under a provider chain, one entry per configured provider in chain order, including providers that only failed (`provider`, `answered`, `failed`, `failures` by class, `benchedAtTurn`, `usage`; no provider text). The event is written once before `run_end`, and a resume or continuation appends to the stored record (#52).
- Chain providers as settings: `createProviderChain({ providers })` takes `ProviderEntry` objects (`{ name, apiKey?, baseUrl?, vars?, headers?, models?, useEnv? }`) alongside provider names. A provider's key, base URL (with `{PLACEHOLDER}` values from `vars`), extra headers and models (by canonical id: a provider id, `null`, or a declaration for a model pi-ai does not list) are settings; the environment fills only what is absent, and `useEnv: false` turns that off for the entry. A model declared without a base URL uses `overrides`, then pi-ai's registry URL for its API, and is refused when none is known (never sent with an empty base URL, which the OpenAI SDK turns into `api.openai.com`). Placeholders are `{[A-Z0-9_]+}` with values of letters, digits, `_`, `.` and `-` (#54).
- `droverVersions()` (`@droveragent/core`, re-exported by both facade entries): the Drover packages loaded in the process and their versions. Every package registers itself when loaded. A release build reports the plain version, a build from a working tree `<version>+local.<sha>`, and unbuilt source `source`; two copies of one package list both, comma-separated (#56, #38).

### Changed

- Release builds stamp each package's `dist/version.js` with its version (`DROVER_RELEASE=1` in the release workflow and `publish-all.sh`); any other build stamps `<version>+local.<sha>`. `scripts/release.ts verify` refuses a tarball whose stamp is not the plain version (#56, #38).
- The `droveragent` umbrella is `"private": true` and not published (npm refused the unscoped name); install `@droveragent/facade` and `@droveragent/core`. Release tooling (`ci.ts pack`, `release.ts` plan / verify / publish, `publish-all.sh`) skips private packages; `release-bump.ts` still bumps them for lockstep (#68).
- `untrustedResultsPlugin`: the in-memory nonce store never evicts a live run (`memoryNonceLimit`). The strings it lets through are kept per tool call and dropped once the call's result is finalised (#64, #45).
- MCP input schemas:
  - `format` is kept only when it is a known JSON Schema format name (`JSON_SCHEMA_FORMATS`); any other value is dropped;
  - `required` keeps only names of sibling `properties`, each once, and drops other entries (an invalid entry used to refuse the tool) (#64, #45).
- Kept provider header values must match a per-header shape: request id, count, reset duration or retry-after. The whole value is checked before the 128-character cap, and a longer value is dropped, not cut. A malformed `Retry-After` still fails over (`AttemptResponse.retryAfterMalformed`) (#72, #59).
- `CheckpointRow.usageByProvider`: libsql and D1 store it inside the existing `usage` JSON column, with no migration. A custom `StorageAdapter` must persist it for `usageByProvider` to stay cumulative across a continuation (#2, #21).

### Fixed

- `quota.maxTurns` is a budget, not a tripwire, again. A final answer (no tool call) on the last allowed turn that passes the output schema ends the run `success`; since the quota refactor it ended `quota` with the answer discarded. A tool call on that turn, or an answer that fails the schema, still ends `quota`. A provider error on that turn ends `error` (`ProviderError`). `postSuccess` is skipped when the answer used the last turn (#50).
- A successful run's latest checkpoint holds the complete history, including the final assistant message and last tool results, and `postSuccess` on a resumed run continues from it. Turn checkpoint writes are ordered and awaited before the final checkpoint and the terminal run update, so a slow adapter cannot land a stale checkpoint last (#2, #21).
- A run that fails or is interrupted before the loop now gives its stored run row a terminal status (`error` / `cancelled`) instead of leaving it `running`. Plugins' `onRunEnd` frees per-run state on those exits too. A hook that throws synchronously cannot replace the result or stop a later plugin from running (#64, #45).
- Under `quota.wrapUp`, a cost or token breach on a call that ends in a provider error ends the run `ProviderError`, not `quota` / `cut_off` (#71, #62).
- Behaviour change: a per-invocation `budget` follows the answer-wins rule. A validated answer on the last allowed turn of `budget.maxTurns` is `success`. A `budget.maxTokens` / `maxCostUsd` breach by a validated final answer is forgiven once the spec's `quota.wrapUp` warning fired, and recorded as `wrapUp.overshoot` with `scope: "budget"` (#71, #62).
- A Worker importing `@droveragent/facade/core` bundles without extra packages: `@droveragent/model` now depends on `@opentelemetry/api`. That package is the optional peer the Mistral SDK inside pi-ai imports statically, which wrangler could not resolve (#70, #69).

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
