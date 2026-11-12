import "./version.ts";
import type { TSchema } from "@sinclair/typebox";
import { Effect } from "effect";

import type {
  AgentInput,
  AgentOutput,
  AgentSpec,
  HarnessEvent,
  HarnessPlugin,
  InvocationBudget,
  RunContext,
  RunResult,
} from "@droveragent/core";
import {
  hashSpec,
  runAgentEffect,
  type AppendedMessage,
  type HarnessDeps,
} from "@droveragent/harness";
import { SandboxError } from "@droveragent/core";
import type { SandboxAdapter } from "@droveragent/sandbox";

/**
 * Run options minus the sandbox. `@droveragent/facade` (the default entry)
 * adds an optional `sandbox` that falls back to just-bash; this
 * `@droveragent/facade/core` entry requires an explicit one.
 */
export interface RunOptionsBase {
  runId?: string;
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  meta?: Record<string, unknown>;
  /** Override the model alias map. */
  modelAliases?: HarnessDeps["modelAliases"];
  /**
   * Host-injected, already-constructed pi-ai models (+ API keys), keyed by
   * the spec's model name (the name part of `ModelSpec`, any `:reasoning`
   * suffix stripped). Checked BEFORE alias / slug / builtin lookup — lets a
   * host with its own model resolver (provider connections, encrypted
   * credentials, models newer than pi-ai's static table) bypass env-var key
   * reading entirely. Per-call `reasoning` / `temperature` / etc. from the
   * spec still apply on top of the injected model.
   */
  models?: HarnessDeps["preResolvedModels"];
  /** Subagent registry. Required when any spec in the run tree uses `subagents`. */
  agentRegistry?: HarnessDeps["agentRegistry"];
  /**
   * Extra plugins attached on top of `spec.plugins`. Useful for observability
   * adapters (tracers, exporters) that the runner injects uniformly across
   * runs without mutating the agent specs themselves.
   */
  plugins?: ReadonlyArray<HarnessPlugin>;
  /**
   * Optional persistence. When provided, drover writes runs, events,
   * checkpoints, and final state to it. Required for pause/resume.
   */
  storage?: HarnessDeps["storage"];
  /**
   * Skill registry. When supplied AND the spec declares `skills`, the
   * harness auto-injects `skill_load` (allowlist-gated) and advertises
   * each allowed skill's name + description in the system prompt.
   */
  skills?: HarnessDeps["skills"];
  /**
   * Connected MCP runtime. When supplied AND the spec declares
   * `mcpServers`, tools from allowlisted servers are composed into the
   * agent's toolset (prefixed `<serverId>__<toolName>`).
   */
  mcpRuntime?: HarnessDeps["mcpRuntime"];
  /**
   * Command registry. Consumed by the spec's `lifecycle` steps of kind
   * `command`; `spec.commands` is the per-agent allowlist.
   */
  commands?: HarnessDeps["commands"];
  /**
   * Memory adapter. When supplied AND `spec.memory?.enabled === true`,
   * the harness auto-injects `remember` / `recall` (and `forget` if
   * `spec.memory.allowForget`), appends a scoped index to the system
   * prompt (unless `includeIndex: false`), and applies a rate-limit
   * plugin matching `writesPerTurn`.
   */
  memory?: HarnessDeps["memory"];
  /**
   * Stream token deltas: forward pi `message_update` events as
   * `assistant_delta` / `thinking_delta` on `events`. Default false —
   * the stream is exactly the whole-message shape (`assistant_text` /
   * `thinking` at message end). Deltas are ephemeral and never persisted
   * to storage. Tool-call argument deltas are always dropped.
   */
  emitDeltas?: boolean;
  /**
   * Patch the provider request body right before it is sent. Called with the
   * built params and the model; return the replacement payload, or `undefined`
   * to leave it unchanged.
   *
   * For provider-specific request preferences drover has no opinion on — the
   * motivating case is OpenRouter routing, e.g.
   * `provider: { order: ["amazon-bedrock/us-east-1"], allow_fallbacks: true }`.
   * Applied to every model call of the run, the compaction summariser included.
   *
   * Never carry secrets in it: this is the request body, not a credential
   * channel.
   */
  onPayload?: HarnessDeps["onPayload"];
  /** Append the provider's raw error text to `ProviderError` messages (default off: it can quote prompt content). */
  includeProviderErrorText?: boolean;
  /**
   * Ordered providers with failover (`createProviderChain` from
   * `@droveragent/model`): a classified provider failure continues the same
   * model call on the next provider, mid-run included. See
   * `docs/guides/provider-chain.mdx`.
   */
  providers?: HarnessDeps["providers"];
  /**
   * Replace the model transport (default: pi's `streamSimple`). The seam for
   * wrappers such as `withProviderCost` (provider-billed cost) or test fakes.
   * A provider chain (`providers`) does not use it.
   */
  streamFn?: HarnessDeps["streamFn"];
  /**
   * A model call whose stream yields no event for this long ends as a provider failure, so a
   * transport that never answers cannot hang the run. Default 600 000 (10 minutes); 0 turns it
   * off. A provider chain has its own (`createProviderChain({ streamIdleTimeoutMs })`).
   */
  streamIdleTimeoutMs?: number;
}

/**
 * Sandbox choice for the core entry: an adapter, or `"disabled"` for no filesystem and no
 * shell at all. (Named `"disabled"`, not `"none"`: `createNoneSandbox()` in
 * `@droveragent/sandbox` is the opposite, the unconfined host filesystem.)
 */
export type CoreSandbox = SandboxAdapter | "disabled";

/**
 * Options of the Worker-friendly entry. `sandbox` is REQUIRED: there is no
 * default, because the default (just-bash) pulls a Node-only filesystem layer
 * into the bundle. `cwd` defaults to `"/"` and `env` to `{}` (no `process`).
 */
export interface CoreRunOptions extends RunOptionsBase {
  sandbox: CoreSandbox;
}

export interface CoreResumeOptions extends ResumeOptionsBase {
  sandbox: CoreSandbox;
}

/**
 * The `"disabled"` sandbox: no filesystem, no shell. Every operation fails with a
 * `SandboxError`, `capabilities.shell` is false (so `bash` is never composed).
 * Right for agents whose tools are all custom/MCP and that need no file access
 * (the Worker case). Not to be confused with `createNoneSandbox()` from
 * `@droveragent/sandbox`, the in-process host-filesystem adapter.
 */
export function createDisabledSandbox(): SandboxAdapter {
  const deny = (op: "exec" | "read" | "write", path: string): Effect.Effect<never, SandboxError> =>
    Effect.fail(
      new SandboxError({
        runId: "(sandbox)",
        op,
        path,
        message: 'sandbox is "disabled": filesystem and shell are unavailable in this run',
      }),
    );
  return {
    id: "disabled",
    capabilities: { shell: false },
    run: (cmd) => deny("exec", cmd),
    readFile: (p) => deny("read", p),
    writeFile: (p) => deny("write", p),
    resolvePath: (p, cwd) => (p.startsWith("/") ? p : `${cwd.replace(/\/$/, "")}/${p}`),
    assertPathAllowed: (p) => deny("read", p),
  };
}

const resolveSandbox = (s: CoreSandbox): SandboxAdapter =>
  s === "disabled" ? createDisabledSandbox() : s;

export interface RunHandle<S extends AgentSpec> {
  runId: string;
  events: AsyncIterable<HarnessEvent>;
  result: Promise<RunResult<AgentOutput<S>>>;
  /** Cancel the run. Terminal status: "cancelled". */
  abort: () => void;
  /**
   * Suspend the run. With `storage` wired: persists the most recent
   * checkpoint and marks `status: "paused"` so a later
   * `resumeAgent(spec, runId, ...)` can pick up. Without storage:
   * degrades to `abort()` — status becomes `cancelled`.
   */
  pause: () => void;
  /**
   * Request a history compaction before the next LLM call. The next
   * `transformContext` pass honours it even when `spec.compaction.trigger`
   * is unset (manual-only policies), then clears the request. `instructions`
   * overrides the summary prompt for that one pass. No-op when
   * `spec.compaction` is absent. Does not require storage.
   */
  compact: (instructions?: string) => void;
}

/**
 * Promise/AsyncIterable facade over the Effect-native run loop.
 *
 * - `events` is fully drained even if the consumer never iterates — the
 *   queue stays bounded by ignoring backpressure when no consumer is
 *   attached. (For high-volume scenarios use the runtime layer instead.)
 * - `result` resolves when the run finishes (success/error/cancelled).
 *   It NEVER rejects — drover-typed errors are folded into
 *   `RunResult.error` with `status: "error"`.
 */
export function runAgent<S extends AgentSpec<TSchema, TSchema>>(
  spec: S,
  input: AgentInput<S>,
  options: CoreRunOptions,
): RunHandle<S> {
  const runId = options.runId ?? cryptoRandomId();
  const cwd = options.cwd ?? "/";
  const env = options.env ?? {};
  const ac = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) ac.abort();
    else options.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  const sandbox = resolveSandbox(options.sandbox);

  const ctx: RunContext = {
    runId,
    depth: 0,
    cwd,
    env,
    signal: ac.signal,
    ...(options.meta ? { meta: options.meta } : {}),
  };

  const stream = createEventStream();

  const deps: HarnessDeps = {
    sandbox,
    ...(options.modelAliases ? { modelAliases: options.modelAliases } : {}),
    ...(options.models ? { preResolvedModels: options.models } : {}),
    ...(options.agentRegistry ? { agentRegistry: options.agentRegistry } : {}),
    ...(options.storage ? { storage: options.storage } : {}),
    ...(options.skills ? { skills: options.skills } : {}),
    ...(options.mcpRuntime ? { mcpRuntime: options.mcpRuntime } : {}),
    ...(options.commands ? { commands: options.commands } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.onPayload ? { onPayload: options.onPayload } : {}),
    ...(options.streamFn ? { streamFn: options.streamFn } : {}),
    ...(options.streamIdleTimeoutMs !== undefined
      ? { streamIdleTimeoutMs: options.streamIdleTimeoutMs }
      : {}),
    ...(options.includeProviderErrorText ? { includeProviderErrorText: true } : {}),
    ...(options.providers ? { providers: options.providers } : {}),
  };

  const effectiveSpec: S =
    options.plugins && options.plugins.length > 0
      ? ({ ...spec, plugins: [...(spec.plugins ?? []), ...options.plugins] } as S)
      : spec;
  const pauseFlag = { requested: false };
  const compactFlag: { requested: boolean; instructions?: string } = { requested: false };
  const effect = runAgentEffect<S>({
    spec: effectiveSpec,
    input,
    ctx,
    emit: stream.emit,
    deps,
    pauseFlag,
    compactFlag,
    ...(options.emitDeltas ? { emitDeltas: true } : {}),
  });

  const result: Promise<RunResult<AgentOutput<S>>> = settleRun<S>(effect, runId, stream.close);

  return {
    runId,
    events: stream.events,
    result,
    abort: (): void => ac.abort(),
    pause: (): void => {
      // Without storage, there's nowhere to persist the checkpoint —
      // returning `paused` would leave the run un-resumable. Degrade
      // cleanly to a regular abort so status becomes `cancelled`.
      if (options.storage) pauseFlag.requested = true;
      ac.abort();
    },
    compact: (instructions?: string): void => {
      compactFlag.requested = true;
      if (instructions !== undefined) compactFlag.instructions = instructions;
    },
  };
}

function cryptoRandomId(): string {
  return `run_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * Resume options. `storage` is required — resume reads the run row +
 * latest checkpoint from it. The spec is validated on resume:
 *   - `spec.id` must match the recorded `agentId`
 *   - `hashSpec(effectiveSpec)` must match the recorded `specHash`
 * If either check fails, `resumeAgent` returns a `RunResult` with
 * `error.tag === "ResumeError"` instead of replaying under a drifted
 * policy. Prefer string `systemPrompt` over function prompts for
 * resumable agents — the hash captures fn source but not closures.
 */
export interface ResumeOptionsBase extends Omit<RunOptionsBase, "runId"> {
  storage: NonNullable<HarnessDeps["storage"]>;
  /**
   * Continue the run with new user message(s). Opt-in: when set, a run with
   * status `success` (finished) can be continued as well as a `paused` one.
   * The messages are appended to the latest checkpoint's history as user
   * turns, then the loop runs. Spec-id and spec-hash validation still apply.
   * Must be non-empty (an empty array is a `ResumeError`).
   *
   * Content is UNTRUSTED when it comes from outside your system (a user, an
   * email, a fetched page): it goes into the model's history as a user turn,
   * so it can carry prompt injection. Pass such an item as
   * `{ content, untrusted: true }`: the run's fencing plugins (for example
   * `untrustedResultsPlugin`, via `wrapUntrusted`, section `"appended-input"`)
   * fence it before it enters the history, after their `assertResumable`
   * check passed. A plain string, or an item without `untrusted: true`, goes
   * in as written. With no fencing plugin on the run, an untrusted item also
   * goes in as written: the flag fences only when a fence is configured.
   *
   * Concurrency: a run that is `running` is refused (`ResumeError`), but the
   * storage adapter has no compare-and-set, so the check and the status flip
   * are not atomic. Two continuations of one run started at the same instant
   * can both pass it and then run interleaved: their events and checkpoints
   * mix under one run id (interleaved seqs, mixed histories, one message set
   * lost) and tool side effects may run twice. The stored run is corrupt, not
   * merely "last write wins". drover does NOT serialise continuations across
   * processes: the host must serialise them per `runId`, e.g. by running each
   * continuation as a job on `@droveragent/runtime`'s `QueueAdapter` (its job
   * lease and `reclaimStale` give one holder at a time), or with a lock or a
   * DB advisory lock.
   *
   * The spec's `quota.maxTurns` and `quota.maxCostUsd` are measured against the
   * cumulative run, so a continuation shares the original run's budget;
   * `quota.maxDurationMs` restarts with each invocation. Use `budget` for a
   * continuation's own limits.
   * `RunResult.usage` is cumulative; `RunResult.usageDelta` is this call only.
   */
  appendMessages?: ReadonlyArray<string | AppendedMessage>;
  /**
   * Budget for THIS resume or continuation alone: turns, tokens (input +
   * output + cache), USD and wall-clock ms counted from where it starts. The
   * spec's `quota` still applies cumulatively across the whole run; the first
   * breach wins and ends the call `status: "quota"` with an
   * `invocation <dimension> budget exceeded` message.
   */
  budget?: InvocationBudget;
}

/**
 * Resume a previously-paused run. Loads the run row + latest checkpoint
 * from storage, then continues pi's agent loop from the saved message
 * list. Fails fast if the run is missing, not in `paused` status, or
 * has no checkpoint.
 */
export function resumeAgent<S extends AgentSpec<TSchema, TSchema>>(
  spec: S,
  runId: string,
  options: CoreResumeOptions,
): RunHandle<S> {
  const cwd = options.cwd ?? "/";
  const env = options.env ?? {};
  const ac = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) ac.abort();
    else options.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  const sandbox = resolveSandbox(options.sandbox);
  const ctx: RunContext = {
    runId,
    depth: 0,
    cwd,
    env,
    signal: ac.signal,
    ...(options.meta ? { meta: options.meta } : {}),
  };

  const stream = createEventStream();

  const deps: HarnessDeps = {
    sandbox,
    storage: options.storage,
    ...(options.modelAliases ? { modelAliases: options.modelAliases } : {}),
    ...(options.models ? { preResolvedModels: options.models } : {}),
    ...(options.agentRegistry ? { agentRegistry: options.agentRegistry } : {}),
    ...(options.skills ? { skills: options.skills } : {}),
    ...(options.mcpRuntime ? { mcpRuntime: options.mcpRuntime } : {}),
    ...(options.commands ? { commands: options.commands } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.onPayload ? { onPayload: options.onPayload } : {}),
    ...(options.streamFn ? { streamFn: options.streamFn } : {}),
    ...(options.streamIdleTimeoutMs !== undefined
      ? { streamIdleTimeoutMs: options.streamIdleTimeoutMs }
      : {}),
    ...(options.includeProviderErrorText ? { includeProviderErrorText: true } : {}),
    ...(options.providers ? { providers: options.providers } : {}),
  };

  const effectiveSpec: S =
    options.plugins && options.plugins.length > 0
      ? ({ ...spec, plugins: [...(spec.plugins ?? []), ...options.plugins] } as S)
      : spec;
  const pauseFlag = { requested: false };
  const compactFlag: { requested: boolean; instructions?: string } = { requested: false };

  const resumeFailure = (tag: string, message: string): RunResult<AgentOutput<S>> => {
    stream.close();
    return {
      runId,
      status: "error",
      finalText: "",
      turns: 0,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      toolCalls: [],
      error: { tag, message },
    } as RunResult<AgentOutput<S>>;
  };

  const result: Promise<RunResult<AgentOutput<S>>> = (async () => {
    // Validate run state BEFORE loading the checkpoint. Order matters:
    // (1) row must exist (otherwise input falls back to {} silently)
    // (2) status must be "paused" (resuming success/error/cancelled would
    //     duplicate tool side effects)
    // (3) agentId must match the spec id (catches "resume foo's run with
    //     bar's code" — would otherwise replay foo's messages under bar's
    //     toolset)
    // (4) checkpoint must exist (paused-but-no-checkpoint is a storage
    //     anomaly, surface it rather than resume from nothing)
    const runRowResult = await Effect.runPromise(Effect.either(options.storage.loadRun(runId)));
    if (runRowResult._tag === "Left") {
      return resumeFailure(
        "ResumeError",
        `loadRun failed for ${runId}: ${(runRowResult.left as { message?: string }).message ?? ""}`,
      );
    }
    const runRow = runRowResult.right;
    if (!runRow) {
      return resumeFailure("ResumeError", `run ${runId} not found in storage`);
    }
    if (runRow.status === "running") {
      return resumeFailure(
        "ResumeError",
        `run ${runId} is marked running: another resume or continuation holds it, or a process ` +
          `that held it crashed (a crashed holder is not reclaimed automatically yet; reset the ` +
          `run's status once you are sure nothing is running it)`,
      );
    }
    const appending = options.appendMessages;
    if (appending !== undefined && appending.length === 0) {
      return resumeFailure("ResumeError", "appendMessages must contain at least one message");
    }
    if (appending !== undefined && !appending.every(isAppendItem)) {
      // A runtime guard: callers outside TypeScript can pass anything.
      return resumeFailure(
        "ResumeError",
        "appendMessages must be strings or { content: string, untrusted?: boolean } objects",
      );
    }
    const continuable = appending !== undefined && runRow.status === "success";
    if (runRow.status !== "paused" && !continuable) {
      return resumeFailure(
        "ResumeError",
        appending !== undefined
          ? `run ${runId} is ${runRow.status}, not paused or success — only those can be continued`
          : `run ${runId} is ${runRow.status}, not paused — only paused runs can resume (pass appendMessages to continue a finished run)`,
      );
    }
    if (runRow.agentId !== spec.id) {
      return resumeFailure(
        "ResumeError",
        `spec mismatch: run ${runId} was recorded under agent "${runRow.agentId}" but resume was called with "${spec.id}"`,
      );
    }
    // Spec-hash check. Hash the EFFECTIVE spec (= base spec ∪ options.plugins)
    // because that's what runAgent stored on the original run — anything
    // else creates an asymmetry and lets injected-plugin drift slip past.
    const currentHash = hashSpec(effectiveSpec);
    if (runRow.specHash !== currentHash) {
      return resumeFailure(
        "ResumeError",
        `spec drift on agent "${spec.id}": recorded hash ${runRow.specHash}, current hash ${currentHash}. The agent definition changed since the run was paused — resuming would replay old messages under a different policy.`,
      );
    }
    const checkpointResult = await Effect.runPromise(
      Effect.either(options.storage.loadLatestCheckpoint(runId)),
    );
    if (checkpointResult._tag === "Left") {
      return resumeFailure(
        "ResumeError",
        `loadLatestCheckpoint failed: ${(checkpointResult.left as { message?: string }).message ?? ""}`,
      );
    }
    const loaded = checkpointResult.right;
    const checkpoint = loaded;
    if (!checkpoint) {
      return resumeFailure(
        "ResumeError",
        `run ${runId} is ${runRow.status} but has no checkpoint — storage anomaly`,
      );
    }
    const input = runRow.input as AgentInput<S>;

    const effect = runAgentEffect<S>({
      spec: effectiveSpec,
      input,
      ctx,
      emit: stream.emit,
      deps,
      resumeFrom: checkpoint,
      // Appended in the harness, after plugins' `assertResumable` (a fence there).
      ...(appending
        ? {
            appendMessages: appending.map(
              (m): AppendedMessage =>
                typeof m === "string"
                  ? { content: m }
                  : { content: m.content, ...(m.untrusted === true ? { untrusted: true } : {}) },
            ),
          }
        : {}),
      ...(options.budget ? { budget: options.budget } : {}),
      pauseFlag,
      compactFlag,
      ...(options.emitDeltas ? { emitDeltas: true } : {}),
    });
    return settleRun<S>(effect, runId, stream.close);
  })();

  return {
    runId,
    events: stream.events,
    result,
    abort: (): void => ac.abort(),
    pause: (): void => {
      pauseFlag.requested = true;
      ac.abort();
    },
    compact: (instructions?: string): void => {
      compactFlag.requested = true;
      if (instructions !== undefined) compactFlag.instructions = instructions;
    },
  };
}

/** A valid `appendMessages` item: a string, or `{ content: string, untrusted?: boolean }` and no other keys. */
function isAppendItem(m: unknown): m is string | AppendedMessage {
  if (typeof m === "string") return true;
  if (typeof m !== "object" || m === null || Array.isArray(m)) return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.content === "string" &&
    (o.untrusted === undefined || typeof o.untrusted === "boolean") &&
    Object.keys(o).every((k) => k === "content" || k === "untrusted")
  );
}

/**
 * Run the harness effect to a `RunResult`, always closing the event stream. A typed failure
 * becomes `status: "error"` (or `"cancelled"`) with its tag; an unexpected throw (a defect,
 * e.g. a malformed option the harness did not catch) becomes `status: "error"` with tag
 * `"InternalError"`, instead of a rejected promise and an event stream that never ends.
 */
async function settleRun<S extends AgentSpec<TSchema, TSchema>>(
  effect: Effect.Effect<RunResult<AgentOutput<S>>, unknown, never>,
  runId: string,
  close: () => void,
): Promise<RunResult<AgentOutput<S>>> {
  const failed = (tag: string, message: string): RunResult<AgentOutput<S>> =>
    ({
      runId,
      status: tag === "CancelledError" ? "cancelled" : "error",
      finalText: "",
      turns: 0,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      toolCalls: [],
      error: { tag, message },
    }) as RunResult<AgentOutput<S>>;
  try {
    const either = await Effect.runPromise(Effect.either(effect));
    if (either._tag === "Right") return either.right;
    const err = either.left;
    return failed(
      (err as { _tag?: string })._tag ?? "Error",
      (err as { message?: string }).message ?? String(err),
    );
  } catch (defect) {
    const cause = (defect as { cause?: unknown }).cause ?? defect;
    return failed("InternalError", cause instanceof Error ? cause.message : String(cause));
  } finally {
    close();
  }
}

/**
 * Internal helper — bounded queue with a waker. Encapsulated so the
 * `let waker` doesn't fight TS's flow analysis across closures.
 */
function createEventStream(): {
  emit: (e: HarnessEvent) => void;
  close: () => void;
  events: AsyncIterable<HarnessEvent>;
} {
  const queue: HarnessEvent[] = [];
  const state: { waker: (() => void) | null; done: boolean } = { waker: null, done: false };

  const wake = (): void => {
    if (state.waker) {
      const w = state.waker;
      state.waker = null;
      w();
    }
  };

  return {
    emit: (e): void => {
      queue.push(e);
      wake();
    },
    close: (): void => {
      state.done = true;
      wake();
    },
    events: {
      [Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
        return {
          async next(): Promise<IteratorResult<HarnessEvent>> {
            while (queue.length === 0 && !state.done) {
              await new Promise<void>((resolve) => {
                state.waker = resolve;
              });
            }
            const e = queue.shift();
            if (e !== undefined) return { value: e, done: false };
            return { value: undefined, done: true };
          },
        };
      },
    },
  };
}

export type {
  AgentSpec,
  AgentInput,
  AgentOutput,
  HarnessEvent,
  InvocationBudget,
  RunResult,
} from "@droveragent/core";
export { droverVersions } from "@droveragent/core";
export {
  staticRegistry,
  withProviderCost,
  type AgentRegistry,
  type AppendedMessage,
  type PreResolvedModel,
} from "@droveragent/harness";
export {
  createProviderChain,
  FAILOVER,
  type ProviderChain,
  type ProviderChainOptions,
} from "@droveragent/model";
