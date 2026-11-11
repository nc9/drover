import type { HarnessPlugin, ToolDecision } from "@droveragent/core";
import { Effect } from "effect";

export interface ToolCallCapOptions {
  /** Cap on tool calls of any kind in one run. */
  maxCalls?: number;
  /** Per-tool caps (by tool name), on top of `maxCalls`. */
  perTool?: Readonly<Record<string, number>>;
  /**
   * What the model reads when a call is refused. Default tells it the cap, and
   * to stop calling tools and answer with what it has.
   */
  message?: (info: { toolName: string; scope: "total" | "tool"; limit: number }) => string;
}

const defaultMessage: NonNullable<ToolCallCapOptions["message"]> = ({ toolName, scope, limit }) =>
  scope === "total"
    ? `tool call cap reached: ${limit} calls allowed in this run and all are used. Do not call more tools; give your final answer with what you have.`
    : `tool call cap reached for ${toolName}: ${limit} calls allowed in this run. Do not call ${toolName} again; use what you have or other tools.`;

/**
 * Cap how many tool calls a run may make. A call over the cap is refused with
 * a tool error the model can act on (it sees the reason and the loop goes on),
 * instead of the run being killed. Refused calls do not count against the cap,
 * so a model that keeps asking is told the same thing, not billed twice.
 *
 * Counts are kept per run id, so one plugin instance can be shared by agents
 * running concurrently. Pair with a turn budget (`quota.maxTurns`) so a model
 * that ignores the refusal still ends.
 */
export function toolCallCapPlugin(opts: ToolCallCapOptions): HarnessPlugin {
  const message = opts.message ?? defaultMessage;
  const runs = new Map<string, { total: number; byTool: Map<string, number> }>();
  return {
    id: "tool-call-cap",
    beforeToolCall: (toolName, _input, ctx) =>
      Effect.sync((): ToolDecision => {
        let s = runs.get(ctx.runId);
        if (!s) {
          s = { total: 0, byTool: new Map() };
          runs.set(ctx.runId, s);
        }
        if (opts.maxCalls !== undefined && s.total >= opts.maxCalls) {
          return {
            kind: "deny",
            reason: message({ toolName, scope: "total", limit: opts.maxCalls }),
          };
        }
        // Tool names come from the model: own keys only (`constructor` is not a cap).
        const cap =
          opts.perTool && Object.hasOwn(opts.perTool, toolName)
            ? opts.perTool[toolName]
            : undefined;
        const used = s.byTool.get(toolName) ?? 0;
        if (cap !== undefined && used >= cap) {
          return { kind: "deny", reason: message({ toolName, scope: "tool", limit: cap }) };
        }
        s.total += 1;
        s.byTool.set(toolName, used + 1);
        return { kind: "allow" };
      }),
    // Free the counters when the run ends.
    onRunEnd: (_result, ctx) => Effect.sync(() => void runs.delete(ctx.runId)),
  };
}
