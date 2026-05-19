import type { HarnessEvent, HarnessPlugin } from "@drover/core";
import { Effect } from "effect";

export type ConfirmDecision =
  | { kind: "approve" }
  | { kind: "reject"; reason?: string };

export interface ConfirmGateOptions {
  /**
   * Tool ids that require confirmation. Anything not on the list passes
   * through. Wildcard `"*"` requires confirmation for every tool (rare;
   * useful for review-only mode).
   */
  tools: ReadonlyArray<string>;
  /**
   * Resolver: called once per requiring tool call. Returns approve/reject.
   * The resolver decides where it asks the human — CLI prompt, web UI,
   * Slack, etc. drover doesn't ship a resolver; that's project-side.
   */
  resolve: (request: ConfirmRequest) => Promise<ConfirmDecision> | ConfirmDecision;
  /**
   * Auto-reject after this many ms with `{ kind: "reject", reason }`.
   * `undefined` = wait forever. Default 5 minutes.
   */
  timeoutMs?: number | undefined;
}

export interface ConfirmRequest {
  /** Run that emitted the request. */
  runId: string;
  toolName: string;
  /** The tool's raw input — useful for the resolver to summarise for humans. */
  input: unknown;
}

/**
 * Synchronous confirmation gate. When a watched tool is about to be
 * invoked, the plugin calls `resolve` and only allows the call if the
 * decision is `approve`. Rejection becomes a deny with the resolver's
 * reason — the model sees a normal tool-deny and can adapt.
 *
 * This is the simpler "inline" form. For durable async confirmations
 * (suspend the whole run, persist a `pending_confirmation`, resume from
 * an external `POST /confirm`), use the runtime layer + storage's
 * `pending_confirmations` table — that's a future drover/runtime
 * primitive built on top of this same plugin shape.
 */
export function confirmGatePlugin(opts: ConfirmGateOptions): HarnessPlugin {
  const wildcard = opts.tools.includes("*");
  const watch = wildcard ? null : new Set(opts.tools);
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  return {
    id: "confirm-gate",
    beforeToolCall: (toolName, input, ctx) =>
      Effect.tryPromise({
        try: async () => {
          if (watch && !watch.has(toolName)) return { kind: "allow" as const };
          const decisionPromise = Promise.resolve(
            opts.resolve({ runId: ctx.runId, toolName, input }),
          );
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise =
            timeoutMs > 0
              ? new Promise<ConfirmDecision>((resolve) => {
                  timer = setTimeout(
                    () =>
                      resolve({
                        kind: "reject",
                        reason: `confirm-gate timed out after ${timeoutMs}ms`,
                      }),
                    timeoutMs,
                  );
                })
              : new Promise<ConfirmDecision>(() => {}); // never
          const decision = await Promise.race([decisionPromise, timeoutPromise]);
          if (timer) clearTimeout(timer);
          if (decision.kind === "approve") return { kind: "allow" as const };
          return {
            kind: "deny" as const,
            reason: `confirm-gate denied ${toolName}${decision.reason ? `: ${decision.reason}` : ""}`,
          };
        },
        catch: () => undefined as never,
      }) as Effect.Effect<
        { kind: "allow" } | { kind: "deny"; reason: string },
        never,
        never
      >,
  };
}

// Re-export the HarnessEvent type so callers can build resolvers that
// peek at the event stream (e.g. surface in-flight thinking to humans).
export type { HarnessEvent };
