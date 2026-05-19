# drover

Agent harness library. Effect-native internals, TypeBox schemas, `pi-agent-core` underneath. Headless (no TUI).

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
| `drover/sandbox` | `SandboxAdapter` interface; `none` and `process` impls |
| `drover/storage` | `StorageAdapter` interface; default libsql impl |
| `drover/runtime` | (opt-in) worker pool, lease queue, run API, crash recovery |
| `drover/eval` | `ScenarioRunner`, `Scorer`, `Reporter` |

## v0 surface

Shipped: `core`, `harness`, `facade`, `model`, `sandbox`, `tools`,
`plugins` (loop-detect, step-tracer, bash-blocklist, circuit-breaker,
write-policy, phase-recorder, confirm-gate, output-validate), `storage`
(memory + libsql), `mcp`, `skills`, `runtime` (worker pool + lease
queue + RunApi), plus an eval suite and the `eval-viewer` Vite app.

Out of scope for v0: heavier sandbox adapters beyond `none`/`process`,
OTel/Langfuse exporters (clean plugin slot), HTTP wrapper around RunApi,
distributed multi-machine runtime.
