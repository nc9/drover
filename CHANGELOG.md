# Changelog

All workspace packages (`@droveragent/*` + the `droveragent` umbrella) version together.

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
