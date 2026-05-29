import type { HarnessEvent, HarnessPlugin } from "@droveragent/core";
import { Effect } from "effect";

export type ConfirmDecision =
  | { kind: "approve" }
  | { kind: "reject"; reason?: string };

/**
 * Gating strategy for the confirm gate:
 *  - `allowlist` — confirm tools whose id is on `tools`. Wildcard `"*"`
 *    confirms every tool (review-only mode).
 *  - `destructive` — confirm any tool whose `ToolDef.destructive` flag is
 *    true, regardless of name. Relies on the harness threading the resolved
 *    tool through `beforeToolCall`'s `meta` argument.
 */
export type ConfirmGateMode =
  | { kind: "allowlist"; tools: ReadonlyArray<string> }
  | { kind: "destructive" };

export interface ConfirmGateOptions {
  /**
   * @deprecated Provide `mode: { kind: "allowlist", tools }` instead.
   * Retained for backward compatibility: when `mode` is omitted these tool
   * ids form the allowlist.
   */
  tools?: ReadonlyArray<string>;
  /**
   * Gating strategy. Defaults to an `allowlist` built from the legacy
   * `tools` field (empty allowlist — confirms nothing — when neither is set).
   */
  mode?: ConfirmGateMode;
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
  /**
   * pi-agent-core's id for this specific invocation. Handy as a key when
   * the resolver parks the request in a pending registry and resolves it
   * from an out-of-band channel.
   */
  toolUseId?: string;
}

/**
 * Confirmation gate. When a tool that requires confirmation is about to
 * be invoked, the plugin calls `resolve` and only allows the call if the
 * decision is `approve`. Rejection becomes a deny with the resolver's
 * reason — the model sees a normal tool-deny and can adapt.
 *
 * Two gating modes (see {@link ConfirmGateMode}): a per-agent name
 * `allowlist`, or a `destructive`-flag check. The legacy `{ tools }`
 * form is normalised to `allowlist`.
 *
 * `resolve` may be async and is awaited via `Effect.tryPromise`, so a
 * resolver that parks the request (persist a pending row, return a
 * Promise that settles on an external `POST /confirm`) suspends the
 * fiber for the duration — no extra runtime primitive required.
 */
export function confirmGatePlugin(opts: ConfirmGateOptions): HarnessPlugin {
  const mode: ConfirmGateMode = opts.mode ?? {
    kind: "allowlist",
    tools: opts.tools ?? [],
  };
  // For allowlist mode: null means wildcard (confirm everything).
  const watch =
    mode.kind === "allowlist" && !mode.tools.includes("*")
      ? new Set(mode.tools)
      : null;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  return {
    id: "confirm-gate",
    beforeToolCall: (toolName, input, ctx, meta) =>
      Effect.tryPromise({
        try: async () => {
          const needsConfirm =
            mode.kind === "destructive"
              ? meta?.tool?.destructive === true
              : watch
                ? watch.has(toolName)
                : true; // allowlist wildcard
          if (!needsConfirm) return { kind: "allow" as const };

          const decisionPromise = Promise.resolve(
            opts.resolve({
              runId: ctx.runId,
              toolName,
              input,
              ...(meta?.toolUseId !== undefined ? { toolUseId: meta.toolUseId } : {}),
            }),
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
