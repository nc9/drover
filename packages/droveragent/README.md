# droveragent

> **Not published yet.** npm refused the unscoped name `droveragent` (too similar to an
> existing package), so this package is `"private": true` until a name is chosen. Use
> [`@droveragent/facade`](https://www.npmjs.com/package/@droveragent/facade) (`runAgent`,
> `resumeAgent`) and [`@droveragent/core`](https://www.npmjs.com/package/@droveragent/core)
> (`defineAgent`) instead.

Headless agent harness — define agents and run them.

This is the umbrella entry point. It re-exports [`@droveragent/facade`](https://www.npmjs.com/package/@droveragent/facade)
(run / resume) plus `defineAgent` from [`@droveragent/core`](https://www.npmjs.com/package/@droveragent/core),
so the essentials are reachable from one unscoped import:

```ts
import { defineAgent, runAgent } from "droveragent";

const agent = defineAgent({
  id: "echo",
  systemPrompt: "You are a helpful assistant.",
});

const handle = runAgent(agent, { prompt: "Hello" });
const result = await handle.result;
console.log(result.finalText);
```

For anything beyond define + run, import the scoped packages directly:

| Package                                                   | Purpose                                                |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `@droveragent/facade`                                     | `runAgent` / `resumeAgent` Promise + AsyncIterable API |
| `@droveragent/core`                                       | `defineAgent`, agent spec, events, errors              |
| `@droveragent/harness`                                    | Effect-native run loop, registry                       |
| `@droveragent/plugins`                                    | hook bundles (tools + intercepts + observers)          |
| `@droveragent/tools`                                      | built-in tools                                         |
| `@droveragent/storage`                                    | libsql persistence + `StorageAdapter`                  |
| `@droveragent/sandbox` / `@droveragent/sandbox-just-bash` | sandbox interface + default adapter                    |
| `@droveragent/runtime`                                    | lower-level Effect runtime layer                       |
