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
  usage: Usage;
  /** Tool ids invoked during the run, in order. Duplicates preserved. */
  toolCalls: ReadonlyArray<string>;
  /** Tagged error when `status === "error"`. */
  error?: { tag: string; message: string };
}
