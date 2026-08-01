import type { TSchema } from "@sinclair/typebox";
import { Effect } from "effect";
import * as path from "node:path";

import type {
  AgentInput,
  AgentOutput,
  AgentSpec,
  HarnessEvent,
  HarnessPlugin,
  RunContext,
  RunResult,
} from "@droveragent/core";
import { hashSpec, runAgentEffect, type HarnessDeps } from "@droveragent/harness";
import type { SandboxAdapter } from "@droveragent/sandbox";
import { createJustBashSandbox } from "@droveragent/sandbox-just-bash";

export interface RunOptions {
  runId?: string;
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  meta?: Record<string, unknown>;
  /**
   * Override the sandbox adapter. Defaults to a just-bash virtual sandbox
   * with the run cwd mounted read-write — isolated (no host network, no
   * filesystem access outside the mount) and safe for `bash` by default.
   */
  sandbox?: SandboxAdapter;
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
}

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
  options?: RunOptions,
): RunHandle<S> {
  const runId = options?.runId ?? cryptoRandomId();
  // Resolve to an absolute path: a relative `options.cwd` (e.g. ".") is a
  // valid host directory but an invalid just-bash mount target.
  const cwd = path.resolve(options?.cwd ?? process.cwd());
  const env =
    options?.env ??
    (Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>);
  const ac = new AbortController();
  if (options?.signal) {
    if (options.signal.aborted) ac.abort();
    else options.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  const sandbox =
    options?.sandbox ??
    createJustBashSandbox({
      mounts: [{ source: cwd, target: cwd, mode: "readwrite" }],
      cwd,
    });

  const ctx: RunContext = {
    runId,
    depth: 0,
    cwd,
    env,
    signal: ac.signal,
    ...(options?.meta ? { meta: options.meta } : {}),
  };

  const stream = createEventStream();

  const deps: HarnessDeps = {
    sandbox,
    ...(options?.modelAliases ? { modelAliases: options.modelAliases } : {}),
    ...(options?.models ? { preResolvedModels: options.models } : {}),
    ...(options?.agentRegistry ? { agentRegistry: options.agentRegistry } : {}),
    ...(options?.storage ? { storage: options.storage } : {}),
    ...(options?.skills ? { skills: options.skills } : {}),
    ...(options?.mcpRuntime ? { mcpRuntime: options.mcpRuntime } : {}),
    ...(options?.commands ? { commands: options.commands } : {}),
    ...(options?.memory ? { memory: options.memory } : {}),
  };

  const effectiveSpec: S =
    options?.plugins && options.plugins.length > 0
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
    ...(options?.emitDeltas ? { emitDeltas: true } : {}),
  });

  const result: Promise<RunResult<AgentOutput<S>>> = Effect.runPromise(Effect.either(effect)).then(
    (either) => {
      stream.close();
      if (either._tag === "Right") return either.right;
      const err = either.left;
      const tag = (err as { _tag?: string })._tag ?? "Error";
      const message = (err as { message?: string }).message ?? String(err);
      const out: RunResult<AgentOutput<S>> = {
        runId,
        status: tag === "CancelledError" ? "cancelled" : "error",
        finalText: "",
        turns: 0,
        durationMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        toolCalls: [],
        error: { tag, message },
      };
      return out;
    },
  );

  return {
    runId,
    events: stream.events,
    result,
    abort: (): void => ac.abort(),
    pause: (): void => {
      // Without storage, there's nowhere to persist the checkpoint —
      // returning `paused` would leave the run un-resumable. Degrade
      // cleanly to a regular abort so status becomes `cancelled`.
      if (options?.storage) pauseFlag.requested = true;
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
export interface ResumeOptions extends Omit<RunOptions, "runId"> {
  storage: NonNullable<HarnessDeps["storage"]>;
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
  options: ResumeOptions,
): RunHandle<S> {
  // Resolve to an absolute path: a relative `options.cwd` (e.g. ".") is a
  // valid host directory but an invalid just-bash mount target.
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env =
    options.env ??
    (Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>);
  const ac = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) ac.abort();
    else options.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  const sandbox =
    options.sandbox ??
    createJustBashSandbox({
      mounts: [{ source: cwd, target: cwd, mode: "readwrite" }],
      cwd,
    });
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
    if (runRow.status !== "paused") {
      return resumeFailure(
        "ResumeError",
        `run ${runId} is ${runRow.status}, not paused — only paused runs can resume`,
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
    const checkpoint = checkpointResult.right;
    if (!checkpoint) {
      return resumeFailure(
        "ResumeError",
        `run ${runId} is paused but has no checkpoint — storage anomaly`,
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
      pauseFlag,
      compactFlag,
      ...(options.emitDeltas ? { emitDeltas: true } : {}),
    });
    const either = await Effect.runPromise(Effect.either(effect));
    stream.close();
    if (either._tag === "Right") return either.right;
    const err = either.left;
    const tag = (err as { _tag?: string })._tag ?? "Error";
    const message = (err as { message?: string }).message ?? String(err);
    return {
      runId,
      status: tag === "CancelledError" ? "cancelled" : "error",
      finalText: "",
      turns: 0,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      toolCalls: [],
      error: { tag, message },
    } as RunResult<AgentOutput<S>>;
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
  RunResult,
} from "@droveragent/core";
export { staticRegistry, type AgentRegistry, type PreResolvedModel } from "@droveragent/harness";
