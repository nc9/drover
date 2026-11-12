import type { Usage } from "./events.ts";

/**
 * Terminal status of a finished run.
 *
 * `paused` is a non-terminal outcome from the harness's perspective —
 * the run is suspended waiting on an external signal (confirm-gate,
 * explicit pause). Resuming continues from the last checkpoint.
 */
export type RunStatus = "success" | "quota" | "cancelled" | "error" | "paused";

/** What every run returns on completion (or where it left off, if paused). */
export interface RunResult<TOutput = unknown> {
  runId: string;
  status: RunStatus;
  /** Decoded against `AgentSpec.outputSchema`. Undefined if status !== "success". */
  output?: TOutput;
  /** Final assistant text — useful when output schema is `Type.Any()`. */
  finalText: string;
  turns: number;
  durationMs: number;
  /** Cumulative across the run, including earlier segments when resumed/continued. */
  usage: Usage;
  /**
   * `usage` split by the provider that served each call. Present when the
   * assistant messages name their provider (always, under a provider chain).
   */
  usageByProvider?: Record<string, Usage>;
  /**
   * Present when `quota.wrapUp` fired: which budget crossed its threshold, and
   * how the run ended. `outcome` is `wrapped_up` for `status: "success"` and
   * `cut_off` for `status: "quota"`; it is absent for a paused, cancelled or
   * errored run. `overshoot` is set when the final, validated answer's own call
   * crossed a cost or token budget: the answer wins and the run is `success`.
   */
  wrapUp?: {
    dimension: "turns" | "duration" | "cost" | "tokens";
    limit: number;
    used: number;
    outcome?: "wrapped_up" | "cut_off";
    overshoot?: {
      dimension: "cost" | "tokens";
      limit: number;
      observed: number;
      /** Which limit was crossed: the spec's cumulative `quota`, or this invocation's `budget`. */
      scope: "spec" | "budget";
    };
  };
  /** Usage of THIS invocation only. Equals `usage` for a fresh run. */
  usageDelta?: Usage;
  /** Tool ids invoked during the run, in order. Duplicates preserved. */
  toolCalls: ReadonlyArray<string>;
  /** Tagged error when `status === "error"`. */
  error?: {
    tag: string;
    message: string;
    /** HTTP status of a `ProviderError`, when the provider reported one. */
    status?: number;
  };
}
