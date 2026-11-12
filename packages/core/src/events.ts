import type { CompactionStrategy } from "./compaction.ts";
import type { ChainRecordEntry } from "./result.ts";

/**
 * Token + cost accounting for a single LLM call. Cumulative aggregation
 * happens in the storage layer; events carry per-call deltas.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * Tokens the model spent reasoning, when the provider reports them (pi-ai `Usage.reasoning`).
   * A SUBSET of `outputTokens`, not an addition to it: `outputTokens` still includes them. Absent,
   * never 0, when the provider reports no split (pi-ai fills 0 for several providers that return
   * none, so 0 and "not reported" cannot be told apart). Summed per run like the other token fields.
   */
  reasoningTokens?: number;
  /** USD cost for this call, computed from $/M-token rates. */
  costUsd?: number;
}

/**
 * Why a provider call failed, as the provider chain classifies it. The table
 * of which classes fail over lives in `@droveragent/model` (`FAILOVER`).
 */
export type ProviderFailureClass =
  | "credits_exhausted"
  | "key_refused"
  | "region_refused"
  | "forbidden"
  | "rate_limited"
  | "provider_error"
  | "timeout"
  | "malformed_response"
  | "model_unavailable"
  | "invalid_request"
  | "other";

/** Tool invocation result envelope. Mirrors pi-agent-core's shape. */
export interface ToolResult {
  /** Stringified content returned to the model. */
  content: string;
  /** True if the tool errored — model sees `is_error` flag. */
  isError?: boolean;
  /** Optional structured payload for plugins/observers. */
  data?: unknown;
  /**
   * Set by the harness when a `beforeToolCall` plugin refused the call (the tool did
   * not run): which plugin, and its decision's `code` when it gave one. Absent for a
   * tool that ran, whether it succeeded or failed.
   */
  denied?: { plugin: string; code?: string };
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
  /**
   * Incremental assistant-text token delta, streamed while the model is
   * producing a message. Opt-in via the run option `emitDeltas` (default
   * off — without it the event stream is exactly the non-delta shape).
   * Ephemeral: deltas are NOT persisted to storage; the whole-message
   * `assistant_text` at message end remains the durable record.
   */
  | { kind: "assistant_delta"; runId: string; turn: number; text: string; ts: number }
  /**
   * Incremental thinking/reasoning token delta. Same opt-in + ephemeral
   * semantics as `assistant_delta`; the whole-block `thinking` event at
   * message end remains the durable record.
   */
  | { kind: "thinking_delta"; runId: string; turn: number; text: string; ts: number }
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
      /**
       * Trust hint for `result`: tool output is data from outside the harness. The harness stamps
       * `untrusted`; a consumer must not treat it as instructions or markup. Absent in older traces
       * (treat as untrusted). A hint only: a stored trace can be edited to say `trusted`, so a viewer
       * must never loosen escaping because of it.
       */
      trust?: "trusted" | "untrusted";
      ts: number;
    }
  | {
      kind: "usage";
      runId: string;
      turn: number;
      usage: Usage;
      /** Provider that served the call (`openrouter`, `cloudflare-ai-gateway`, ...), when the message names it. */
      provider?: string;
      /** Model id as the serving provider named it. */
      model?: string;
      ts: number;
    }
  /**
   * The provider chain reacted to a failed model call: `retry` the same
   * provider after a wait (rate limit), `failover` to the next provider, or
   * `exhausted` (no provider left, or the class does not fail over). Carries
   * the failure class and status, never the provider's text (which can quote
   * the prompt).
   */
  | {
      kind: "provider_failover";
      runId: string;
      action: "retry" | "failover" | "exhausted";
      /**
       * On `failover` and `exhausted`: `true` when `from` is now skipped (tried last) for the
       * rest of the run, `false` when it was only passed over for this call.
       */
      benched?: boolean;
      from: string;
      /** Next provider; null for `retry` (same provider) and `exhausted`. */
      to: string | null;
      failureClass: ProviderFailureClass;
      status: number | null;
      /** Allow-listed provider error code, e.g. `unsupported_country_region_territory`. */
      code?: string;
      /** Wait before a `retry`, in ms. */
      waitMs?: number;
      ts: number;
    }
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
  /**
   * A budget crossed its `quota.wrapUp.at` fraction: the model was told to
   * finish. Emitted once per run (and again on a resumed run).
   */
  | {
      kind: "budget_warning";
      runId: string;
      dimension: "turns" | "duration" | "cost" | "tokens";
      limit: number;
      used: number;
      ts: number;
    }
  /**
   * The run's provider chain record, emitted once before `run_end` when the run uses a
   * provider chain (the same as `RunResult.chainRecord`). No provider text.
   */
  | {
      kind: "chain_record";
      runId: string;
      providers: ChainRecordEntry[];
      ts: number;
    }
  /**
   * Something the host should fix, that did not stop the run. `code` names it;
   * `message` is the harness's own text (never model, tool or user text).
   * - `untrusted_unfenced`: an `appendMessages` item marked `untrusted: true`
   *   went into the history as written because no plugin on the run fences
   *   (`wrapUntrusted`); `count` is how many.
   */
  | {
      kind: "warning";
      runId: string;
      code: "untrusted_unfenced";
      message: string;
      count: number;
      ts: number;
    }
  | {
      kind: "output_validated";
      runId: string;
      /** The answer parsed only after `spec.outputRepair`'s syntactic repair (`repairJson`). */
      repaired?: true;
      ts: number;
    }
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
  | {
      kind: "error";
      runId: string;
      tag: string;
      message: string;
      /** HTTP status of a `ProviderError`, when the provider reported one. */
      status?: number;
      /**
       * Structured provider fields of a `ProviderError`, when known (a provider chain's last
       * attempt): the allow-listed error `code`, the error `type`, and the wait the provider
       * asked for (`retryAfterMs`). Plain tokens and numbers only; never provider text.
       */
      details?: ProviderErrorDetails;
      ts: number;
    };

/** Narrow on `kind`. */
export type EventOfKind<K extends HarnessEvent["kind"]> = Extract<HarnessEvent, { kind: K }>;

/**
 * Structured fields of a provider error (`error.details` on the `error` event and
 * `RunResult.error`). Every field is optional and present only when known.
 */
export interface ProviderErrorDetails {
  /** Allow-listed provider error code (e.g. `insufficient_quota`). */
  code?: string;
  /** The provider's error type (e.g. `rate_limit_error`), as a plain token. */
  type?: string;
  /** The wait the provider asked for, in ms. */
  retryAfterMs?: number;
}
