import type { HarnessPlugin, ToolDecision } from "@droveragent/core";
import { Effect } from "effect";

import { canonicalJsonStringify } from "./internal/canonical-json.ts";

export interface RepeatRefusalOptions {
  /**
   * Tools worth retrying as-is (a transient network error): how many identical repeats of a
   * failed call are still executed before the guard answers. Default 0 for every tool.
   */
  retryable?: Readonly<Record<string, number>>;
  /**
   * Per-tool key for "the same call", when two argument sets mean the same operation
   * (`{ fetch: (a) => new URL(a.url).href }`). Default: the arguments with object keys
   * sorted and strings trimmed.
   */
  keyFor?: Readonly<Record<string, (input: unknown) => string>>;
  /**
   * Refusals that are NOT the call's fault and must not be remembered, by deny `code`.
   * `tool_call_cap` (a budget, not a refusal of this call) and this plugin's own
   * `repeat_refusal` are always ignored.
   */
  ignoreDenyCodes?: readonly string[];
  /** Failed calls remembered per run (oldest forgotten first). Default 256. */
  maxFailuresPerRun?: number;
  /** Runs remembered (least recently used forgotten first). Default 1000. */
  maxRuns?: number;
}

export interface RepeatRefusalUsage {
  /** Tool calls in the run that failed (a tool error, or a refusal by a policy plugin). */
  failed: number;
  /** Calls this guard answered without running the tool. */
  repeated: number;
}

interface Failure {
  count: number;
  /** 1-based tool-call number of the first failure, in this run. */
  firstCall: number;
}

interface RunState {
  failures: Map<string, Failure>;
  /** Tool-use id -> fingerprint and call number, from `tool_call_start` until `tool_call_end`. */
  pending: Map<string, { fp: string; call: number }>;
  calls: number;
  usage: RepeatRefusalUsage;
}

const ALWAYS_IGNORED = ["tool_call_cap", "repeat_refusal"];

/** Sort keys (canonical JSON does) and trim every string, recursively. */
const normalise = (v: unknown): unknown => {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(normalise);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = normalise(x);
    return out;
  }
  return v;
};

/**
 * Stops the model resending a tool call that already failed in this run. Each call is
 * fingerprinted (tool name plus normalised arguments, or a per-tool key); when a fingerprint
 * that failed is sent again, the guard answers without running the tool, with a message the
 * model can act on, and the refusal carries `code: "repeat_refusal"`.
 *
 * "Failed" is read from structured flags, never from text: a tool result with `isError`, or a
 * refusal by another `beforeToolCall` plugin, except refusals whose deny `code` says they are
 * not about this call (`tool_call_cap` and this guard's own, plus `ignoreDenyCodes`). A later
 * success of the same call (a retryable tool) forgets the failure.
 *
 * The message names the earlier failure (tool, how many times, which call) and does not quote
 * the tool's text: tool output is untrusted and is not echoed back.
 *
 * Memory is per run id, bounded (`maxFailuresPerRun`, `maxRuns`), and kept after the run ends,
 * so a continuation of the run in the same process (same run id) still knows its failures. It
 * lives in memory: a resume in another process starts empty.
 */
export function repeatRefusalPlugin(opts: RepeatRefusalOptions = {}): HarnessPlugin & {
  /** Counters for a run, for host metrics and evals; undefined if the run is unknown. */
  usage(runId: string): RepeatRefusalUsage | undefined;
} {
  const maxFailures = opts.maxFailuresPerRun ?? 256;
  const maxRuns = opts.maxRuns ?? 1000;
  const ignored = new Set([...ALWAYS_IGNORED, ...(opts.ignoreDenyCodes ?? [])]);
  const runs = new Map<string, RunState>();

  const stateFor = (runId: string): RunState => {
    let s = runs.get(runId);
    if (s)
      runs.delete(runId); // re-insert: most recently used last
    else
      s = { failures: new Map(), pending: new Map(), calls: 0, usage: { failed: 0, repeated: 0 } };
    runs.set(runId, s);
    while (runs.size > maxRuns) runs.delete(runs.keys().next().value!);
    return s;
  };

  const own = <V>(rec: Readonly<Record<string, V>> | undefined, k: string): V | undefined =>
    rec !== undefined && Object.hasOwn(rec, k) ? rec[k] : undefined;

  const fingerprint = (toolName: string, input: unknown): string => {
    const key = own(opts.keyFor, toolName);
    let body: string;
    try {
      body = key ? key(input) : canonicalJsonStringify(normalise(input));
    } catch {
      body = "unkeyable"; // circular or a throwing key function: one shared bucket per tool
    }
    return `${toolName}\u0000${body}`;
  };

  return {
    id: "repeat-refusal",
    usage: (runId) => {
      const s = runs.get(runId);
      return s ? { ...s.usage } : undefined;
    },
    beforeToolCall: (toolName, input, ctx) =>
      Effect.sync((): ToolDecision => {
        const s = stateFor(ctx.runId);
        const f = s.failures.get(fingerprint(toolName, input));
        if (!f) return { kind: "allow" };
        const repeats = own(opts.retryable, toolName) ?? 0;
        if (f.count <= repeats) return { kind: "allow" };
        s.usage.repeated += 1;
        const times = f.count === 1 ? "once" : `${f.count} times`;
        return {
          kind: "deny",
          code: "repeat_refusal",
          reason:
            `This exact ${toolName} call already failed ${times} in this run (first at tool call ` +
            `${f.firstCall}), so it was not run again. Change the arguments, try a different ` +
            `approach, or stop and report what you have.`,
        };
      }),
    onEvent: (e, ctx) =>
      Effect.sync(() => {
        if (e.kind === "tool_call_start") {
          const s = stateFor(ctx.runId);
          s.calls += 1;
          s.pending.set(e.toolUseId, { fp: fingerprint(e.toolName, e.input), call: s.calls });
          return;
        }
        if (e.kind !== "tool_call_end") return;
        const s = stateFor(ctx.runId);
        const started = s.pending.get(e.toolUseId);
        s.pending.delete(e.toolUseId);
        if (!started) return;
        const code = e.result.denied?.code;
        if (code !== undefined && ignored.has(code)) return;
        if (e.result.isError !== true) {
          s.failures.delete(started.fp); // it worked this time: forget the failure
          return;
        }
        s.usage.failed += 1;
        const f = s.failures.get(started.fp);
        if (f) {
          f.count += 1;
          s.failures.delete(started.fp); // re-insert: most recent last
          s.failures.set(started.fp, f);
        } else s.failures.set(started.fp, { count: 1, firstCall: started.call });
        while (s.failures.size > maxFailures) s.failures.delete(s.failures.keys().next().value!);
      }),
  };
}
