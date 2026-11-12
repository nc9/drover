import type { Effect } from "effect";

import type { RunContext } from "./context.ts";
import type { HarnessEvent, ToolResult, Usage } from "./events.ts";
import type { HarnessError } from "./errors.ts";
import type { RunResult } from "./result.ts";
import type { AnyToolDef } from "./tool.ts";

/**
 * Decision returned by `beforeToolCall`. v0 supports two outcomes:
 *   - allow: proceed unchanged
 *   - deny:  short-circuit with a synthesised error result. The reason
 *            string is returned to the model so it can adapt.
 *
 * Input rewriting and confirmation-gated suspension are planned but not
 * yet wired through pi-agent-core's hooks + the runtime / storage layer.
 * If you need to rewrite a tool's input, use `wrapTool` instead (the
 * plugin wraps the tool and transforms args before delegating).
 */
export type ToolDecision =
  | { kind: "allow" }
  | {
      kind: "deny";
      reason: string;
      /**
       * Machine-readable source of the refusal (e.g. `tool_call_cap`, `repeat_refusal`),
       * for observers that must tell a policy or budget refusal from a tool's own failure.
       * It reaches observers as `ToolResult.denied.code`; the model sees only `reason`.
       */
      code?: string;
    };

/**
 * Decision returned by `beforeModelCall`. `refuse` ends the run with `status: "error"` and the
 * given tag and message, before that model call is made.
 */
export type ModelCallDecision =
  | { kind: "allow" }
  | { kind: "refuse"; tag: string; message: string };

/** What a `beforeModelCall` hook is told about the call about to be made. */
export interface ModelCallInfo {
  /** 1-based count of model calls in this invocation of the run (the first call is 1). */
  callNumber: number;
  /** Usage accumulated so far in the run, cost included. */
  usage: Usage;
}

/**
 * Recovery returned by `onError`. Lets plugins decide whether a thrown
 * error halts the run or is converted into a continuation signal.
 */
export type ErrorRecovery =
  | { kind: "rethrow" }
  | { kind: "swallow" }
  /** Inject a synthetic user message and continue the loop. */
  | { kind: "continue_with_message"; message: string };

/**
 * Optional out-of-band context handed to `beforeToolCall`. Lets a gate
 * inspect the resolved tool definition (e.g. its `destructive` flag) or
 * key a pending decision by the invocation id, without changing the
 * positional `toolName` / `input` / `ctx` contract.
 */
export interface BeforeToolCallMeta {
  /** The resolved tool definition for `toolName`, when the harness can find it. */
  tool?: AnyToolDef;
  /** pi-agent-core's id for this specific tool invocation. */
  toolUseId?: string;
}

/**
 * Per-message transcript shape passed to `beforeCompaction`. Plugins
 * may rewrite the history (e.g. strip large tool outputs) before the
 * compaction summariser runs.
 */
export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Estimated token count, if known. */
  tokens?: number;
}

/**
 * Bundle of capabilities that hook into the run. Plugins compose
 * cleanly because each capability is optional — a plugin can contribute
 * only tools, only an observer, or any mix.
 *
 * Registration order matters: `beforeToolCall` chains short-circuit on
 * the first non-allow decision; `wrapTool` composes outermost-last.
 */
export interface HarnessPlugin {
  /** Unique among plugins attached to one agent. */
  id: string;

  /** Tools contributed by this plugin (added to the agent's toolset). */
  tools?: ReadonlyArray<AnyToolDef>;

  /**
   * Decorate any tool before it's handed to the model loop. Use this
   * for timing, redaction, or wrapping result content; for permission
   * decisions use `beforeToolCall` instead (clearer contract).
   */
  wrapTool?: (tool: AnyToolDef) => AnyToolDef;

  beforeToolCall?: (
    toolName: string,
    input: unknown,
    ctx: RunContext,
    meta?: BeforeToolCallMeta,
  ) => Effect.Effect<ToolDecision, HarnessError, never>;

  afterToolCall?: (
    toolName: string,
    input: unknown,
    result: ToolResult,
    ctx: RunContext,
    /** `toolUseId`: the id of this tool call (the one the tool's `execute` saw), when known. */
    meta?: { toolUseId?: string },
  ) => Effect.Effect<ToolResult, HarnessError, never>;

  beforeCompaction?: (
    history: ReadonlyArray<HistoryMessage>,
    ctx: RunContext,
  ) => Effect.Effect<ReadonlyArray<HistoryMessage>, HarnessError, never>;

  /**
   * Observation only. Return value is ignored; errors are swallowed
   * (logged at debug) so observers can't crash a run.
   */
  onEvent?: (event: HarnessEvent, ctx: RunContext) => Effect.Effect<void, never, never>;

  /**
   * Run-level lifecycle. Fired once after context assembly + `init`,
   * before the first model call. Observation only — for metrics,
   * webhooks, and similar side effects. Async effects are awaited;
   * failures and defects are swallowed.
   */
  onRunStart?: (ctx: RunContext) => Effect.Effect<void, never, never>;

  /**
   * Run-level lifecycle. Fired exactly once per run, on every exit: after the
   * loop + `postSuccess` finish and the terminal status is resolved, or, when
   * the run fails, dies or is interrupted before that, with a synthetic result
   * (`status: "error"`, or `"cancelled"` for an interrupt). Observation only;
   * async effects are awaited, failures, defects and synchronous throws
   * swallowed. During an interrupt it runs uninterruptibly (the interrupt waits
   * for it), so keep it fast.
   */
  onRunEnd?: (result: RunResult, ctx: RunContext) => Effect.Effect<void, never, never>;

  /**
   * Text appended to the system prompt for this run (and given to the
   * compaction summariser). A fence plugin uses it to carry its fence note, so
   * the host cannot forget it.
   */
  systemPromptAddendum?: (ctx: RunContext) => string | undefined;

  /**
   * Fence text the harness itself puts in front of the model that is derived
   * from, or may contain, untrusted input: the compaction summary and the
   * untrusted entries of the memory index. Returns the text to use instead.
   */
  wrapUntrusted?: (section: string, text: string, ctx: RunContext) => string;

  /**
   * Subagents run with this plugin too (added to the child's plugins unless it
   * already has one with the same id). The child is a separate run, so per-run
   * state such as a fence nonce is its own.
   */
  inheritToSubagents?: boolean;

  /**
   * Called when a run is resumed from a checkpoint, before anything runs. Throw
   * a message to refuse the resume (a fence plugin refuses when it cannot
   * recover the run's nonce, because the restored history carries fences that
   * name the old one).
   */
  assertResumable?: (ctx: RunContext) => void;

  /**
   * Called before every model call (including the first). May refuse: the run then ends
   * `error` with the plugin's tag and message, with no model call made. For admission control:
   * a balance preflight, a rate guard. Failures and defects of the hook are swallowed (the call
   * is allowed): a broken guard must not take the run down.
   */
  beforeModelCall?: (
    info: ModelCallInfo,
    ctx: RunContext,
  ) => Effect.Effect<ModelCallDecision, never, never>;

  onError?: (error: HarnessError, ctx: RunContext) => Effect.Effect<ErrorRecovery, never, never>;
}
