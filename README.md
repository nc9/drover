# drover

A declarative, strongly-typed, Effect-native agent harness library for TypeScript.

Define agents as JSON-serialisable specs. The API surface is Effect-first, with a `Promise`/`AsyncIterable` facade as a fallback for non-Effect consumers. TypeBox schemas, `pi-agent-core` underneath. Headless — no TUI.

## Features

- **Declarative agent specs** — `defineAgent({...})` returns a JSON-serialisable, TypeBox-typed `AgentSpec`; dynamic agents use the same shape.
- **Effect-first API** — internals and public surface speak `Effect`; `Promise`/`AsyncIterable` facade kept as a fallback.
- **Schemaed agent loop** — typed input/output, output retry budget on schema-decode failures.
- **Streaming events** — normalised `HarnessEvent` stream as an `AsyncIterable`.
- **Plugin hooks** — `HarnessPlugin` bundles: `beforeToolCall` / `afterToolCall` / `wrapTool` / `onEvent` / `onError`.
- **Built-in plugins** — loop-detect, step-tracer, bash-blocklist, circuit-breaker, write-policy, phase-recorder, confirm-gate, output-validate.
- **Built-in tools** — bash, read, write, edit, grep, …
- **Subagents** — `taskTool` factory; depth ≤ 2, fan-out ≤ 3 caps; child lifecycle events on the parent stream.
- **Skills** — `SKILL.md` loader + `skill_load` tool, progressive disclosure.
- **Instruction files** — `AGENTS.md` / `CLAUDE.md` loaders.
- **MCP** — stdio + HTTP transports, tool-name prefixing, per-agent allowlist.
- **Model layer** — pi-ai wrapper, alias resolver, routing interface, circuit breaker.
- **Pause / resume** — durable checkpoints; resume validates run id / status / agent id / spec hash before replay.
- **Storage** — libsql default + `StorageAdapter`; in-memory adapter for tests.
- **Sandbox** — `SandboxAdapter` interface; just-bash virtual sandbox by default (isolated, docker-style mounts, `bash`-safe), plus in-process `none`.
- **Runtime (opt-in)** — worker pool, lease queue, `RunApi`, crash recovery.
- **Evals** — `ScenarioRunner`, `Scorer`, `Reporter`, plus the eval-viewer app.

## Status

Pre-alpha. Public surface stabilising; do not depend on it yet.

## Packages

| Package | Purpose |
|---|---|
| `drover/core` | `AgentSpec`, `HarnessEvent`, `RunContext`, tagged errors |
| `drover/harness` | `pi-agent-core` integration, run loop, compaction |
| `drover/facade` | `Promise` + `AsyncIterable` wrapper around the Effect surface |
| `drover/plugins` | Built-in `HarnessPlugin` bundles (loop-detect, confirm-gate, step-tracer, …) |
| `drover/tools` | Built-in `ToolDef` library (bash, read, write, edit, grep, …) |
| `drover/skills` | `SKILL.md` loader + `skill_load` tool |
| `drover/mcp` | MCP runtime, per-agent allowlist, transport adapters |
| `drover/model` | pi-ai wrapper, alias resolver, routing interface, circuit breaker |
| `drover/sandbox` | `SandboxAdapter` interface; in-process `none` impl |
| `drover/sandbox-just-bash` | just-bash virtual sandbox (default) — isolated, docker-style mounts |
| `drover/storage` | `StorageAdapter` interface; default libsql impl |
| `drover/runtime` | (opt-in) worker pool, lease queue, run API, crash recovery |
| `drover/eval` | `ScenarioRunner`, `Scorer`, `Reporter` |

## v0 surface

Shipped: `core`, `harness`, `facade`, `model`, `sandbox` +
`sandbox-just-bash` (default), `tools`, `plugins` (loop-detect,
step-tracer, bash-blocklist, circuit-breaker, write-policy,
phase-recorder, confirm-gate, output-validate), `storage` (memory +
libsql), `mcp`, `skills`, `runtime` (worker pool + lease queue +
RunApi), plus an eval suite and the `eval-viewer` Vite app.

Out of scope for v0: heavier OS-level sandbox adapters (SBPL / docker /
daytona — projects keep their own), OTel/Langfuse exporters (clean
plugin slot), HTTP wrapper around RunApi, distributed multi-machine
runtime.
