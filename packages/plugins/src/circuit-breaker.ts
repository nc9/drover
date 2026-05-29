import type { HarnessPlugin } from "@droveragent/core";
import { Effect } from "effect";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before the breaker opens. Default 5. */
  failureThreshold?: number;
  /** Cooldown after which the breaker enters half-open state. Default 30s. */
  cooldownMs?: number;
  /** Tool ids the breaker watches. Default: all tools. */
  toolIds?: ReadonlyArray<string>;
}

interface BreakerState {
  failures: number;
  openUntil: number;
}

/**
 * Per-tool circuit breaker. Opens after `failureThreshold` consecutive
 * `isError === true` results from the same tool id; while open, the
 * `beforeToolCall` short-circuits with a deny. After `cooldownMs` the
 * breaker enters half-open (one trial allowed); a successful trial
 * resets the failure count.
 *
 * Companion to `loopDetectPlugin`: loop-detect catches "tool returns
 * wrong answer", circuit-breaker catches "tool keeps erroring". Apply
 * both for full retry-loop protection.
 */
export function circuitBreakerPlugin(opts: CircuitBreakerOptions = {}): HarnessPlugin {
  const threshold = Math.max(2, opts.failureThreshold ?? 5);
  const cooldown = Math.max(1_000, opts.cooldownMs ?? 30_000);
  const toolFilter = opts.toolIds ? new Set(opts.toolIds) : null;
  const state = new Map<string, BreakerState>();

  const watch = (id: string): boolean => !toolFilter || toolFilter.has(id);

  return {
    id: "circuit-breaker",
    beforeToolCall: (toolName) =>
      Effect.sync(() => {
        if (!watch(toolName)) return { kind: "allow" as const };
        const s = state.get(toolName);
        if (!s) return { kind: "allow" as const };
        if (s.openUntil > Date.now()) {
          return {
            kind: "deny" as const,
            reason: `circuit-breaker: ${toolName} is open until ${new Date(s.openUntil).toISOString()} (${s.failures} consecutive failures). Try a different approach.`,
          };
        }
        return { kind: "allow" as const };
      }),
    afterToolCall: (toolName, _input, result) =>
      Effect.sync(() => {
        if (watch(toolName)) {
          const s = state.get(toolName) ?? { failures: 0, openUntil: 0 };
          if (result.isError) {
            s.failures += 1;
            if (s.failures >= threshold) {
              s.openUntil = Date.now() + cooldown;
            }
          } else {
            // Success — reset.
            s.failures = 0;
            s.openUntil = 0;
          }
          state.set(toolName, s);
        }
        return result;
      }),
  };
}
