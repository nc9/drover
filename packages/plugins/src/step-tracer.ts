import type { HarnessEvent, HarnessPlugin } from "@drover/core";
import { Effect } from "effect";

/**
 * Compact granular trace row — uniform shape for downstream UIs and
 * exporters regardless of whether the storage layer is hooked up.
 */
export interface TraceStep {
  ts: number;
  turn: number;
  kind: TraceStepKind;
  /** Tool name when kind === "tool". Model name when kind === "llm_call". */
  name?: string;
  durationMs?: number;
  /** Tokens for `llm_call`/`usage`; bytes for `tool` content; etc. */
  meta?: Readonly<Record<string, unknown>>;
}

export type TraceStepKind =
  | "run_start"
  | "input_validated"
  | "turn_start"
  | "llm_call"
  | "tool"
  | "tool_error"
  | "usage"
  | "compaction"
  | "subagent"
  | "output_retry"
  | "run_end"
  | "error";

export interface StepTracer {
  steps: ReadonlyArray<TraceStep>;
  plugin: HarnessPlugin;
}

/**
 * Project the live event stream into a flat list of trace steps. Cheap
 * to leave attached; safe to share across runs (each run gets its own
 * counter by virtue of fresh `runId` on events).
 *
 * Typical use: pass `tracer.plugin` to the agent spec, read
 * `tracer.steps` after the run completes for reporting/persistence.
 */
export function stepTracerPlugin(): StepTracer {
  const steps: TraceStep[] = [];
  const toolStarts = new Map<string, { ts: number; turn: number; toolName: string }>();

  const record = (e: HarnessEvent): void => {
    switch (e.kind) {
      case "run_start":
        steps.push({ ts: e.ts, turn: 0, kind: "run_start", name: e.agentId });
        return;
      case "input_validated":
        steps.push({ ts: e.ts, turn: 0, kind: "input_validated" });
        return;
      case "turn_start":
        steps.push({ ts: e.ts, turn: e.turn, kind: "turn_start" });
        return;
      case "llm_call":
        steps.push({
          ts: e.ts,
          turn: e.turn,
          kind: "llm_call",
          name: e.modelName,
          ...(e.reasoning ? { meta: { reasoning: e.reasoning } } : {}),
        });
        return;
      case "tool_call_start":
        toolStarts.set(e.toolUseId, { ts: e.ts, turn: e.turn, toolName: e.toolName });
        return;
      case "tool_call_end": {
        const start = toolStarts.get(e.toolUseId);
        toolStarts.delete(e.toolUseId);
        steps.push({
          ts: e.ts,
          turn: e.turn,
          kind: e.result.isError ? "tool_error" : "tool",
          name: e.toolName,
          durationMs: start ? e.ts - start.ts : e.durationMs,
          meta: { bytes: e.result.content.length },
        });
        return;
      }
      case "usage":
        steps.push({
          ts: e.ts,
          turn: e.turn,
          kind: "usage",
          meta: {
            in: e.usage.inputTokens,
            out: e.usage.outputTokens,
            ...(e.usage.costUsd !== undefined ? { cost: e.usage.costUsd } : {}),
          },
        });
        return;
      case "compaction":
        steps.push({
          ts: e.ts,
          turn: 0,
          kind: "compaction",
          meta: {
            beforeTokens: e.beforeTokens,
            afterTokens: e.afterTokens,
            collapsed: e.collapsedRange,
          },
        });
        return;
      case "subagent_start":
        steps.push({ ts: e.ts, turn: 0, kind: "subagent", name: e.agentId, meta: { childRunId: e.childRunId, phase: "start" } });
        return;
      case "subagent_end":
        steps.push({ ts: e.ts, turn: 0, kind: "subagent", name: "(end)", meta: { childRunId: e.childRunId, status: e.status, phase: "end" } });
        return;
      case "output_retry":
        steps.push({ ts: e.ts, turn: 0, kind: "output_retry", meta: { attempt: e.attempt, reason: e.reason } });
        return;
      case "run_end":
        steps.push({ ts: e.ts, turn: 0, kind: "run_end", meta: { status: e.status } });
        return;
      case "error":
        steps.push({ ts: e.ts, turn: 0, kind: "error", name: e.tag, meta: { message: e.message } });
        return;
      default:
        return;
    }
  };

  const plugin: HarnessPlugin = {
    id: "step-tracer",
    onEvent: (event) =>
      Effect.sync(() => {
        record(event);
      }),
  };

  return { steps, plugin };
}
