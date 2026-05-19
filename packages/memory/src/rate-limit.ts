import type { HarnessPlugin, ToolDecision } from "@drover/core";
import { Effect } from "effect";

export interface MemoryRateLimitOptions {
  /** Default 1. Set 0 to disable (no plugin should be wired in that case). */
  writesPerTurn?: number;
  /** Tool ids to gate. Default `["remember"]`. */
  toolIds?: ReadonlyArray<string>;
}

/**
 * Per-turn write rate-limit for memory tools. Counts invocations of
 * `remember` (or any tool in `toolIds`) inside one turn; denies further
 * calls past the cap.
 *
 * Counter resets on every `turn_start` event. Auto-wired by the harness
 * when `spec.memory.enabled` and `writesPerTurn > 0`.
 */
export function memoryRateLimitPlugin(opts: MemoryRateLimitOptions = {}): HarnessPlugin {
  const cap = Math.max(1, opts.writesPerTurn ?? 1);
  const gated = new Set(opts.toolIds ?? ["remember"]);
  let count = 0;

  return {
    id: "memory-rate-limit",
    beforeToolCall: (toolName) =>
      Effect.sync((): ToolDecision => {
        if (!gated.has(toolName)) return { kind: "allow" };
        if (count >= cap) {
          return {
            kind: "deny",
            reason: `memory write rate limit hit (${cap}/turn). Combine into one entry or wait until next turn.`,
          };
        }
        count++;
        return { kind: "allow" };
      }),
    onEvent: (event) =>
      Effect.sync(() => {
        if (event.kind === "turn_start") count = 0;
      }),
  };
}
