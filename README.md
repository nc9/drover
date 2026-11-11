# drover

[![CI](https://github.com/nc9/drover/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nc9/drover/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/droveragent.svg)](https://www.npmjs.com/package/droveragent)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A declarative, strongly typed, Effect-native agent harness for TypeScript. Define agents as JSON-serialisable specs, run them headless, stream normalised events.

**Docs:** https://nc9.github.io/drover/

## Install

```bash
bun add droveragent @sinclair/typebox
```

Drover runs on [Bun](https://bun.sh) 1.3+. Default model aliases route through OpenRouter, so set `OPENROUTER_API_KEY` before running.

## Quickstart

<!-- quickstart:start -->

```ts
import { Type } from "@sinclair/typebox";
import { defineAgent, runAgent } from "droveragent";

const echo = defineAgent({
  id: "echo",
  systemPrompt: "Reply with a JSON object matching the outputSchema. No prose.",
  inputSchema: Type.Object({ word: Type.String() }),
  outputSchema: Type.Object({ upper: Type.String(), length: Type.Integer() }),
  model: "cheap",
  tools: [],
  quota: { maxTurns: 2 },
});

const handle = runAgent(echo, { word: "drover" });

for await (const event of handle.events) {
  if (event.kind === "assistant_text") console.log(event.text);
}

const result = await handle.result;
console.log(result.status, result.output, result.usage);
```

<!-- quickstart:end -->

The same file lives at [`packages/droveragent/examples/quickstart.ts`](packages/droveragent/examples/quickstart.ts) and is typechecked in CI. For a full walkthrough see the [quickstart guide](https://nc9.github.io/drover/guides/quickstart).

## What you get

- Typed agent specs (TypeBox) with schemaed input and output and an output retry budget.
- A normalised `HarnessEvent` stream, plus plugin hooks around every tool call and run.
- Built-in tools, subagents, skills, commands, MCP, pause and resume, storage and an opt-in runtime.
- A sandbox interface with a just-bash virtual sandbox by default.
- An eval suite and viewer.

## Packages

<!-- packages:start -->

| Package                           | What it is                                                            | Status  |
| --------------------------------- | --------------------------------------------------------------------- | ------- |
| `droveragent`                     | Umbrella entry point: `defineAgent` and `runAgent`                    | Preview |
| `@droveragent/core`               | `AgentSpec`, `HarnessEvent`, `RunContext`, tagged errors              | Preview |
| `@droveragent/harness`            | Effect-native run loop, compaction, registry                          | Preview |
| `@droveragent/facade`             | `Promise` and `AsyncIterable` wrapper over the Effect surface         | Preview |
| `@droveragent/plugins`            | Built-in plugin bundles (loop-detect, confirm-gate, step-tracer, ...) | Preview |
| `@droveragent/tools`              | Built-in tools (bash, read, write, edit, grep, ...)                   | Preview |
| `@droveragent/skills`             | `SKILL.md` loader and `skill_load` tool                               | Preview |
| `@droveragent/commands`           | Markdown command loader and registry                                  | Preview |
| `@droveragent/prompt`             | Prompt templates and cache analyzer                                   | Preview |
| `@droveragent/memory`             | Agent memory                                                          | Preview |
| `@droveragent/mcp`                | MCP runtime, per-agent allowlist, transports                          | Preview |
| `@droveragent/model`              | Model aliases, routing interface, circuit breaker                     | Preview |
| `@droveragent/sandbox`            | `SandboxAdapter` interface and in-process `none` implementation       | Preview |
| `@droveragent/sandbox-just-bash`  | just-bash virtual sandbox (default)                                   | Preview |
| `@droveragent/sandbox-vercel`     | Vercel sandbox adapter                                                | Preview |
| `@droveragent/sandbox-cloudflare` | Cloudflare sandbox adapter                                            | Preview |
| `@droveragent/storage`            | `StorageAdapter` interface, memory and libsql implementations         | Preview |
| `@droveragent/storage-d1`         | Cloudflare D1 storage adapter                                         | Preview |
| `@droveragent/runtime`            | Opt-in worker pool, lease queue, run API, crash recovery              | Preview |
| `@droveragent/eval`               | `ScenarioRunner`, `Scorer`, `Reporter`                                | Preview |

<!-- packages:end -->

Preview means the API is stabilising and may change between 0.x releases.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE) (c) 2026 Nik Cubrilovic
