---
name: implementing-with-drover
description: Build a production consumer of the drover agent harness, or a new SandboxAdapter / StorageAdapter for it. Covers the defineAgent → runAgent flow, the adapter contracts (including the load-bearing shell capability gate), plugin hooks, and the patterns real consumers depend on — DataRef stores, capability confinement, egress-proxy secret injection, pre-resolved model injection, and HarnessEvent → SSE translation. Use when wiring drover into an app, writing or reviewing a `@droveragent/*` adapter package, or debugging why a tool, model or sandbox isn't behaving.
---

# Implementing with drover

Drover is a headless agent harness over `pi-agent-core`. Effect-native
internals, a thin Promise/AsyncIterable facade, TypeBox schemas everywhere,
tagged errors via `Data.TaggedError`.

This skill is the accumulated field knowledge. Add to it whenever something
surprises you.

## The flow

```ts
import { defineAgent } from "@droveragent/core";
import { runAgent } from "@droveragent/facade";
import { Type } from "@sinclair/typebox";

const spec = defineAgent({
  id: "my-agent",
  systemPrompt: renderedPromptString,   // string, not a fn — see below
  inputSchema: Type.String(),
  outputSchema: Type.Any(),
  model: "my-symbolic-model",
  tools: ["bash"],
  plugins: [myPlugin],
  quota: { maxTurns: 24, maxDurationMs: 240_000, maxCostUsd: 3 },
});

const handle = runAgent(spec, userMessage, {
  models: preResolvedModels,   // Map<specName, {model, apiKey}>
  sandbox: mySandbox,          // ALWAYS set — see confinement
  storage: myStorage,
  env: {},                     // ALWAYS set — see confinement
  cwd: "/workspace",
  emitDeltas: true,
  meta: { orgId, userId, conversationId },
  signal,
});

for await (const event of handle.events) { /* translate */ }
const result = await handle.result;   // never rejects
```

`handle.result` folds drover-typed errors into `RunResult.error` with
`status: "error"` — it does not reject. `handle.abort()` yields
`status: "cancelled"`; `handle.pause()` needs `storage` wired or it degrades
to an abort.

`AgentSpec` is JSON-serialisable data. Build it **per request** when the
prompt carries conversation history or the plugins close over per-request
state — module-scope specs leak history and, in a multi-tenant app, one
tenant's data into the next request.

### Prefer a string `systemPrompt`

`hashSpec` captures a `SystemPromptFn`'s source but not its closures, so a
function prompt makes `resumeAgent` replay under a drifted policy without
noticing. A string hashes exactly what the run saw.

### Resume is hash-gated

`resumeAgent` refuses when `spec.id` or `hashSpec(effectiveSpec)` doesn't
match the recorded run. The hash covers `description`, `model`, tools,
quota, plugins — editing any of them invalidates paused runs. That's the
point, but it means a "harmless" prompt tweak breaks resume.

## SandboxAdapter

```ts
interface SandboxAdapter {
  readonly id: string;
  readonly capabilities: { readonly shell: boolean };
  run(cmd, args, opts?): Effect<ExecResult, SandboxError>;
  readFile(path): Effect<string, SandboxError>;
  writeFile(path, contents): Effect<void, SandboxError>;
  readdir?(path): Effect<readonly string[], SandboxError>;
  resolvePath(path, cwd): string;
  assertPathAllowed(path): Effect<void, SandboxError>;
}
```

**The shell gate is the whole security model.** `composeTools` skips `bash`
when `deps.sandbox.capabilities.shell` is false — silently, so the agent
simply doesn't see the tool rather than getting unsandboxed exec. Set
`shell: true` only when the adapter is a real isolation boundary (remote VM,
container, seatbelt, docker). Consumers should assert this in tests: it is
the difference between a sandboxed agent and an unsandboxed one.

Contract details that bite:

- **`run` must honour `timeoutMs` and `signal` itself.** `ToolDef.timeoutMs`
  is otherwise unenforced. An expiry resolves with `killed: true` and
  whatever partial output was harvested — it does NOT fail. `SandboxError` is
  reserved for transport/infra failure.
- **`readFile`/`writeFile`/`readdir` have no timeout by contract.** Wrap with
  `Effect.timeout` at the call site if you need one.
- **`assertPathAllowed` may be `Effect.void`** when the sandbox is itself the
  boundary — there is nothing of the host's to escape to. `readFile`/
  `writeFile` are expected to check internally; `run` cannot, because argv is
  opaque. That asymmetry is exactly why `bash` needs the capability gate.
- **`resolvePath` is a pure join** in the sandbox's namespace. No host
  `realpath`.

### Writing a new adapter

Follow `packages/sandbox-vercel` (Firecracker VM) and
`packages/sandbox-cloudflare` (container behind a Durable Object).

1. **Structural-interface DI, not module mocks.** Declare the exact slice of
   the SDK you consume as your own interfaces, take the SDK entry point as an
   injectable `client` option, and put ONE cast at that boundary. The whole
   adapter then type-checks and unit-tests in plain bun with no SDK, no
   credentials and no network. `sandbox-cloudflare` goes further and never
   imports `@cloudflare/sandbox` at all (it only runs in `workerd`), exposing
   a `cloudflareSdkClient(getSandbox, ns)` helper as the single cast.
2. **Lazy, memoised acquisition.** Acquire on first op. Concurrent first ops
   share one in-flight acquire; a failure resets the memo so the next op can
   retry. Acquisition counts against the exec deadline — a cold container can
   take minutes and must not hang a tool call. An expiry *there* is a
   `SandboxError`, not a `killed` result: no process existed yet.
3. **Cap output.** Default 16 KiB tail per stream with a `[truncated: …]`
   note, so a runaway `cat` cannot blow the transcript.
4. **Deny egress by default,** whatever the SDK's own default is.
5. **Declare method-syntax interfaces** for structural slices so the real
   (narrower, overloaded) SDK types stay assignable under bivariance.

## StorageAdapter

Event-sourced: `runs` / `run_events` / `run_checkpoints` /
`pending_confirmations`. `appendEvent` is append-only with caller-supplied
per-run monotonic `seq` (the harness supplies it). Checkpoint `messages` is
opaque — pi's message list, round-tripped for resume.

Storage errors are logged, never fatal: observability must not break
execution.

Reference impls: `packages/storage/src/libsql.ts` (default),
`packages/storage/src/memory.ts`, `packages/storage-d1/src/d1.ts`.

Porting notes from the D1 adapter:

- Schema and migrations live in `@droveragent/storage/migrations` — a
  dependency-free subpath so a Worker adapter never pulls a node-only driver
  into its bundle. Import the SQL, don't fork it.
- A Worker has no top-level `await` where the binding exists, so the D1
  factory is **synchronous** with a lazily memoised migration (failure resets
  and retries) instead of libsql's `await runMigrations` in the factory.
- **D1's `exec` requires one statement per line.** Split the migration SQL
  quote- and comment-aware and submit it via `batch`, which D1 wraps in an
  implicit transaction — so a migration stays atomic.
- Concurrent isolates racing the first migration is fine when every statement
  is `IF NOT EXISTS` / `INSERT OR IGNORE`.
- `close()` is a no-op for runtime-owned bindings.
- Test SQLite-backed adapters against `bun:sqlite` behind the same structural
  interface. Far less friction than booting miniflare, and it *is* SQLite.

## Plugins

`HarnessPlugin` bundles tools + typed before/after intercepts + `onEvent`
observers. Intercepts fire before observation events. Plugins are how a
consumer adds its own tools; `spec.plugins` plus `RunOptions.plugins` are
merged (and both feed the spec hash).

Auto-injected tools are gated on spec-opt-in AND the matching dep being
wired — see `harness/src/capability-gates.ts`:

| Mechanism | Spec field | Required dep |
|---|---|---|
| `task` (subagents) | `subagents` | `agentRegistry` |
| `skill_load` / `skill_resource` | `skills` | `skills` |
| `remember` / `recall` | `memory.enabled` | `memory` |
| MCP tools | `mcpServers` | `mcpRuntime` |
| `bash` | `tools: ["bash"]` | `sandbox.capabilities.shell` |

## Consumer patterns

From `~/Projects/OpenNEM/platform/src/lib/agent` (Vercel) and
`~/Projects/Zenancy/packages/agent` (Cloudflare).

### Confinement: always override `env` and `sandbox`

`runAgent`'s defaults are development conveniences and production hazards.
`env` defaults to the **entire `process.env`**, and the default sandbox is
just-bash with the run cwd mounted read-write and `shell: true` — under
`tools: ["bash"]` that composes bash against the host. Always pass
`env: {}` and an explicit `sandbox`, and pass a shell-less adapter (not
`undefined`) when the sandbox is unconfigured.

### DataRef store: rows never enter the token stream

Data tools fetch, register rows in a per-request store, and return a compact
summary plus a ref id (`data_1`). The model reasons about refs; `render_*`
tools resolve a ref and the server joins the real rows into the emitted
block. This is what prevents hallucinated numbers and keeps a large scan from
costing millions of tokens.

- Per request, never module scope. Stamp it with the tenant id.
- Bound new registrations per run, and make the throw a *corrective* message
  ("render what you have as a partial result") — the model recovers from that.
- Hydrated refs from earlier turns keep their original ids (transcripts quote
  them) and must not count against the turn's bound.
- Cap what gets persisted three ways: ref count, rows per ref, total bytes.
  Newest-first, then restore registration order.
- The prompt transcribes blocks as one-liners, never their rows.

### Secrets never enter the sandbox

Never `setEnvVars`/`env` a credential into the VM — model-authored code can
read it, print it, or exfiltrate it through any allowed host. Attach it at
the egress boundary instead:

- **Vercel Sandbox:** a `NetworkPolicy` domain rule with a `transform` that
  sets the header. Note domain rules control transformation, not admission.
- **Cloudflare:** there is no transform in the sandbox SDK. Use
  `@cloudflare/containers`' Worker-side outbound interception —
  `static outboundHandlers` on the `Sandbox` subclass, selected per host with
  `setOutboundByHost`. The handler runs in the Worker where bindings live.
  Restrict it to the methods you need, and issue a read-only credential.
- Deny-all is the baseline. On Cloudflare, `enableInternet = false` on the
  `Sandbox` DO subclass is the *real* switch; host allowlists layer on top,
  and an adapter cannot read that flag over RPC — so declare it and say so.

### Pre-resolved model injection

Drover resolves `spec.model` through aliases → provider slug → pi-ai's static
builtin table, reading the key from `process.env`. Both halves fail in a real
host: your model id is probably newer than pi-ai's table, and a Worker has no
`process.env`. So construct the `Model` object yourself and inject it:

```ts
const models = new Map([[
  "my-symbolic-model",
  { model: { id, name: id, api: "openai-completions", provider: "openrouter",
             baseUrl: "https://openrouter.ai/api/v1", reasoning: true,
             input: ["text"], cost: {input:1,output:1,cacheRead:1,cacheWrite:1},
             contextWindow: 200_000, maxTokens: 32_768 },
    apiKey },
]]);
```

`RunOptions.models` is checked **before** alias/slug/builtin lookup, which
bypasses env reading entirely. Two details:

- Key it by a **symbolic** name, not a provider slug: `hashSpec` folds
  `model` in, so a slug invalidates resumable runs on every model swap (and
  leaks the provider to your UI).
- `cost` must be non-zero or `quota.maxCostUsd` can never trip. A synthetic
  $1/M on every leg turns the cost ceiling into a live total-token budget.
  Keep those numbers internal — never bill from them.

### Prompt: cacheable-prefix discipline

`@droveragent/prompt` renders `.md.liquid` with drover builtins and reports
`cacheablePrefixChars` — the leading static run a provider can match as a
cached prefix. Everything after the first volatile segment is uncacheable.

- Put every dynamic value in a **trailing tail**, most volatile last (clock
  last).
- **No `{% if %}`.** A control tag is volatile to the analyzer and caps the
  prefix at its position even when the condition is deployment-stable. Select
  variants in TypeScript with prebuilt template strings instead.
- Pre-serialise optional sections *with their own trailing separator* (or
  `""`), so an empty value leaves no gap and needs no tag.
- In a Worker there is no filesystem: the template must be a bundled TS
  constant, not a `path`.
- If your call site must be synchronous, render with liquidjs's
  `parseAndRenderSync` and use `createPromptEngine()` as the test-time
  oracle — assert byte-parity and assert the prefix covers every static
  section.

### HarnessEvent → SSE

Emit `meta` first and `done` last. A useful wire union:
`meta / text_delta / tool_start / tool_end / block / error / done`.

- `run_start`, `turn_start`, `llm_call`, `input_validated`,
  `output_validated`, `compaction`, `prompt_rendered` are internal — don't
  emit them. Fold `usage` into a server-side accumulator; token and cost
  numbers are not user-facing.
- With `emitDeltas: true` you get both `assistant_delta` and a whole-message
  `assistant_text`. Track which turns streamed deltas and suppress the echo
  for those, or the client renders every message twice.
- Buffer deltas per turn. A run that aborts or hits quota mid-message never
  sends `assistant_text`, and the persisted row must not be *less* than what
  the client already saw.
- Insert a `\n\n` break when a new turn's text follows tool calls.
- **Hold `error` back** until `handle.result` settles, then decide. Report
  canned per-class text: a provider message can carry a prompt fragment, a
  key or a token count. Keep the sanitised original for the audit row.
- Frame as `event: <type>\ndata: <json>\n\n` — `JSON.stringify` escapes
  newlines so the payload is always one `data:` line. Send `: ping\n\n`
  every ~15s so a long tool call doesn't trip an idle proxy timeout.

### Per-conversation sandbox

Name the sandbox after the conversation so scratch survives between turns.
Stage this turn's datasets into the container before the run starts; harvest
new output files after each command and register them as refs. Stop it in a
`finally` — best-effort and time-bounded, because a hung teardown must not
wedge persistence or the `done` frame.

## Repo conventions

- `bun`, TypeScript, kebab-case filenames, PascalCase types, camelCase fns.
- `cd packages/<pkg> && bunx tsgo --noEmit`. **Never** `bun run --filter '*'
  typecheck` from the root — it fans out N concurrent tsgo runs and pegs CPU.
- `oxfmt` / `oxlint`. Tests: `bun test` per package.
- Package tsconfigs `include: ["src/**/*"]`, so tests are not typechecked by
  default. `exactOptionalPropertyTypes` is on — a mock's captured
  `options: T | undefined` field must be spelled that way, not `options?: T`.
- Functional style: pure functions and data over classes.
- Commits: `type(scope): message`, scope required.
