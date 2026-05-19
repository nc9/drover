import type { Effect } from "effect";

import type { RunContext } from "./context.ts";
import type { HarnessEvent, ToolResult } from "./events.ts";
import type { HarnessError } from "./errors.ts";
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
  | { kind: "deny"; reason: string };

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
  ) => Effect.Effect<ToolDecision, HarnessError, never>;

  afterToolCall?: (
    toolName: string,
    input: unknown,
    result: ToolResult,
    ctx: RunContext,
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

  onError?: (
    error: HarnessError,
    ctx: RunContext,
  ) => Effect.Effect<ErrorRecovery, never, never>;
}
