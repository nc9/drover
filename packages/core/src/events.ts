import type { CompactionStrategy } from "./compaction.ts";

/**
 * Token + cost accounting for a single LLM call. Cumulative aggregation
 * happens in the storage layer; events carry per-call deltas.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** USD cost for this call, computed from $/M-token rates. */
  costUsd?: number;
}

/** Tool invocation result envelope. Mirrors pi-agent-core's shape. */
export interface ToolResult {
  /** Stringified content returned to the model. */
  content: string;
  /** True if the tool errored — model sees `is_error` flag. */
  isError?: boolean;
  /** Optional structured payload for plugins/observers. */
  data?: unknown;
}

/**
 * The single normalised event the harness emits.
 *
 * Effect surface: `Stream<HarnessEvent>`.
 * Facade surface: `AsyncIterable<HarnessEvent>`.
 *
 * Plugins may observe via `onEvent`; intercepts use the typed before/after
 * hooks on `HarnessPlugin` (which fire *before* observation events).
 */
export type HarnessEvent =
  | { kind: "run_start"; runId: string; agentId: string; specHash: string; ts: number }
  | { kind: "input_validated"; runId: string; ts: number }
  | { kind: "turn_start"; runId: string; turn: number; ts: number }
  | {
      kind: "llm_call";
      runId: string;
      turn: number;
      modelName: string;
      reasoning?: string;
      ts: number;
    }
  | { kind: "assistant_text"; runId: string; turn: number; text: string; ts: number }
  | { kind: "thinking"; runId: string; turn: number; text: string; ts: number }
  | {
      kind: "tool_call_start";
      runId: string;
      turn: number;
      toolUseId: string;
      toolName: string;
      input: unknown;
      ts: number;
    }
  | {
      kind: "tool_call_end";
      runId: string;
      turn: number;
      toolUseId: string;
      toolName: string;
      result: ToolResult;
      durationMs: number;
      ts: number;
    }
  | { kind: "usage"; runId: string; turn: number; usage: Usage; ts: number }
  | {
      kind: "compaction";
      runId: string;
      /** Turn at which the pass fired. */
      turn: number;
      /** What initiated it: an auto threshold breach or an explicit `handle.compact()`. */
      trigger: "auto" | "manual";
      /** Which ladder rung produced this pass. */
      strategy: CompactionStrategy;
      /** Estimated input tokens before the pass. */
      beforeTokens: number;
      /** Estimated input tokens after the pass. */
      afterTokens: number;
      /** `[startIdx, endIdx)` of the collapsed/replaced head span, in the array as this pass saw it. */
      collapsedRange: [number, number];
      /** True only when `strategy === "summarize"` (an LLM sub-call ran). */
      summarized: boolean;
      ts: number;
    }
  | {
      kind: "subagent_start";
      runId: string;
      childRunId: string;
      agentId: string;
      ts: number;
    }
  | {
      kind: "subagent_end";
      runId: string;
      childRunId: string;
      status: "success" | "error" | "cancelled";
      ts: number;
    }
  | { kind: "output_validated"; runId: string; ts: number }
  | { kind: "output_retry"; runId: string; attempt: number; reason: string; ts: number }
  | {
      kind: "run_end";
      runId: string;
      status: "success" | "quota" | "cancelled" | "error" | "paused";
      ts: number;
    }
  | {
      kind: "memory_written";
      runId: string;
      entry: {
        id: string;
        scope: "global" | "agent" | "run";
        kind: "user" | "feedback" | "project" | "reference";
        summary: string;
      };
      ts: number;
    }
  | {
      kind: "memory_recalled";
      runId: string;
      query: string | null;
      scopes: ReadonlyArray<"global" | "agent" | "run">;
      hits: ReadonlyArray<{ id: string; scope: "global" | "agent" | "run"; score: number }>;
      ts: number;
    }
  | {
      kind: "prompt_rendered";
      runId: string;
      /** Length of the leading static run — the cacheable prefix. */
      cacheablePrefixChars: number;
      totalChars: number;
      /** True when `autoReorder` relocated volatile builtins to a footer. */
      reordered: boolean;
      /** Cache-ordering advisories from the analyzer. */
      warnings: ReadonlyArray<string>;
      ts: number;
    }
  | { kind: "error"; runId: string; tag: string; message: string; ts: number };

/** Narrow on `kind`. */
export type EventOfKind<K extends HarnessEvent["kind"]> = Extract<HarnessEvent, { kind: K }>;
