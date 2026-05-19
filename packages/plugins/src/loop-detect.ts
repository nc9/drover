import type { HarnessPlugin, ToolDecision } from "@drover/core";
import { Effect } from "effect";

export interface LoopDetectOptions {
  /**
   * Reject when this many consecutive identical tool calls have been made.
   * Default 3 — empirical sweet-spot before LLMs typically escape on their own.
   */
  window?: number;
  /**
   * Compare by tool name only, ignoring input. False (default) compares
   * the (name, JSON.stringify(input)) tuple — useful for catching e.g.
   * re-running the same exact failing test command.
   */
  ignoreInput?: boolean;
}

/**
 * Catches agents stuck in retry loops on the same tool call. After
 * `window` consecutive identical calls (same name + same input by
 * default), the next attempt is denied with a corrective reason so
 * the model breaks the pattern.
 *
 * State is per-plugin-instance: create one plugin per agent. Don't
 * share across agents — counters would interleave.
 */
export function loopDetectPlugin(opts: LoopDetectOptions = {}): HarnessPlugin {
  const window = Math.max(2, opts.window ?? 3);
  const ignoreInput = opts.ignoreInput ?? false;

  let lastKey = "";
  let streak = 0;

  return {
    id: "loop-detect",
    beforeToolCall: (toolName, input) =>
      Effect.sync((): ToolDecision => {
        const key = ignoreInput ? toolName : `${toolName}:${stableStringify(input)}`;
        if (key === lastKey) {
          streak += 1;
        } else {
          lastKey = key;
          streak = 1;
        }
        if (streak >= window) {
          return {
            kind: "deny",
            reason: `loop detected: same call repeated ${streak}x. Stop retrying — try a different approach, or report the obstacle and stop.`,
          };
        }
        return { kind: "allow" };
      }),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
