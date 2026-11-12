import type { HarnessPlugin, ToolDecision, ToolResult } from "@droveragent/core";
import { Effect } from "effect";

export interface ToolCallCapOptions {
  /** Cap on tool calls of any kind in one run. */
  maxCalls?: number;
  /** Per-tool caps (by tool name), on top of `maxCalls`. */
  perTool?: Readonly<Record<string, number>>;
  /**
   * What the model reads when a call is refused. Default names the cap, the calls used and
   * what to do instead. Gets no tool input: a refusal never echoes arguments.
   */
  message?: (info: {
    toolName: string;
    scope: "total" | "tool";
    limit: number;
    used: number;
  }) => string;
  /**
   * Fraction of a cap at which the model is told, once per cap, that it is close
   * (appended to the result of the call that reaches it). Default `0.8`; `false` turns it off.
   */
  warnAt?: number | false;
}

/** Calls counted so far in one run. */
export interface ToolCallUsage {
  readonly total: number;
  /** Null-prototype record: tool names come from the model and may be `__proto__`. */
  readonly byTool: Readonly<Record<string, number>>;
}

export interface ToolCallCapPlugin extends HarnessPlugin {
  /** Counts for a live run (undefined once the run has ended), e.g. for a host's own metrics. */
  usage: (runId: string) => ToolCallUsage | undefined;
}

const defaultMessage: NonNullable<ToolCallCapOptions["message"]> = ({
  toolName,
  scope,
  limit,
  used,
}) =>
  scope === "total"
    ? `tool call cap reached: ${used} of ${limit} tool calls used in this run. Do not call more tools; give your final answer with what you have.`
    : `tool call cap reached for ${toolName}: ${used} of ${limit} calls used in this run. Do not call ${toolName} again; use what you have or other tools.`;

interface RunCounts {
  total: number;
  byTool: Map<string, number>;
  /** Caps already warned about: "" for the total cap, else the tool name. */
  warned: Set<string>;
}

/**
 * Cap how many tool calls a run may make. A call over the cap is refused with a tool error
 * the model can act on (it sees the reason and the loop goes on) instead of the run being
 * killed. Refused calls do not count, so a model that keeps asking is told the same thing.
 *
 * - Counting happens in `beforeToolCall`, synchronously, so parallel calls in one turn are
 *   counted one at a time and cannot overshoot the cap.
 * - An allowed call counts even if the tool then fails (it ran). Register this plugin AFTER
 *   other `beforeToolCall` gates: a call this plugin allowed but a later plugin denied still
 *   counts.
 * - Counts are per run id and kept across pause/resume (dropped at any other run end). They
 *   live in memory: a resume in another process starts from zero.
 * - Counts are per run id: one instance can serve concurrent runs. A subagent is a separate
 *   run: the parent's `task` call counts once in the parent, and the child is capped only
 *   if its own spec carries a cap plugin.
 * - The refusal is harness-made text (cap, count, tool name), never the tool's input; the
 *   near-cap note is appended to the tool result text.
 *
 * Pair with a turn budget (`quota.maxTurns`) so a model that ignores the refusal still ends.
 */
const assertCap = (what: string, v: number | undefined): void => {
  if (v !== undefined && !(Number.isFinite(v) && v >= 0)) {
    throw new Error(`toolCallCapPlugin: ${what} must be a finite number >= 0, got ${String(v)}`);
  }
};

export function toolCallCapPlugin(opts: ToolCallCapOptions): ToolCallCapPlugin {
  assertCap("maxCalls", opts.maxCalls);
  for (const [name, v] of Object.entries(opts.perTool ?? {})) assertCap(`perTool.${name}`, v);
  if (opts.warnAt !== undefined && opts.warnAt !== false) {
    if (!(Number.isFinite(opts.warnAt) && opts.warnAt > 0 && opts.warnAt <= 1)) {
      throw new Error(
        `toolCallCapPlugin: warnAt must be in (0, 1] or false, got ${String(opts.warnAt)}`,
      );
    }
  }
  const message = opts.message ?? defaultMessage;
  const warnAt = opts.warnAt === undefined ? 0.8 : opts.warnAt;
  const runs = new Map<string, RunCounts>();

  // Tool names come from the model: own keys only (`constructor` is not a cap).
  const toolCap = (toolName: string): number | undefined =>
    opts.perTool && Object.hasOwn(opts.perTool, toolName) ? opts.perTool[toolName] : undefined;

  const countsFor = (runId: string): RunCounts => {
    let s = runs.get(runId);
    if (!s) {
      s = { total: 0, byTool: new Map(), warned: new Set() };
      runs.set(runId, s);
    }
    return s;
  };

  const nearNote = (s: RunCounts, toolName: string): string | undefined => {
    if (warnAt === false) return undefined;
    const notes: string[] = [];
    const max = opts.maxCalls;
    // No `< max` guard: with parallel tool execution every beforeToolCall of a turn runs
    // before any afterToolCall, so the count can already be at the cap here.
    if (max !== undefined && !s.warned.has("") && s.total >= max * warnAt) {
      s.warned.add("");
      notes.push(
        `${s.total} of ${max} tool calls used in this run; ${Math.max(0, max - s.total)} left.`,
      );
    }
    const cap = toolCap(toolName);
    const used = s.byTool.get(toolName) ?? 0;
    const key = `tool:${toolName}`;
    if (cap !== undefined && !s.warned.has(key) && used >= cap * warnAt) {
      s.warned.add(key);
      notes.push(
        `${used} of ${cap} ${toolName} calls used in this run; ${Math.max(0, cap - used)} left.`,
      );
    }
    return notes.length > 0
      ? `[tool call budget: ${notes.join(" ")} Plan to finish with what you have.]`
      : undefined;
  };

  return {
    id: "tool-call-cap",
    beforeToolCall: (toolName, _input, ctx) =>
      Effect.sync((): ToolDecision => {
        const s = countsFor(ctx.runId);
        if (opts.maxCalls !== undefined && s.total >= opts.maxCalls) {
          return {
            kind: "deny",
            code: "tool_call_cap",
            reason: message({ toolName, scope: "total", limit: opts.maxCalls, used: s.total }),
          };
        }
        const cap = toolCap(toolName);
        const used = s.byTool.get(toolName) ?? 0;
        if (cap !== undefined && used >= cap) {
          return {
            kind: "deny",
            code: "tool_call_cap",
            reason: message({ toolName, scope: "tool", limit: cap, used }),
          };
        }
        s.total += 1;
        s.byTool.set(toolName, used + 1);
        return { kind: "allow" };
      }),
    afterToolCall: (toolName, _input, result, ctx) =>
      Effect.sync((): ToolResult => {
        const s = runs.get(ctx.runId);
        const note = s ? nearNote(s, toolName) : undefined;
        return note ? { ...result, content: `${result.content}\n\n${note}` } : result;
      }),
    usage: (runId) => {
      const s = runs.get(runId);
      if (!s) return undefined;
      const byTool = Object.create(null) as Record<string, number>;
      for (const [k, v] of s.byTool) {
        Object.defineProperty(byTool, k, { value: v, enumerable: true });
      }
      return { total: s.total, byTool };
    },
    // Free the counters when the run ends, but not on pause: a resume reuses the run id
    // and must keep its count, or every pause/resume would reset the cap.
    onRunEnd: (result, ctx) =>
      Effect.sync(() => {
        if (result.status !== "paused") runs.delete(ctx.runId);
      }),
  };
}
