import { Data } from "effect";

/**
 * Input failed `inputSchema` decode at run start. Fast-fail — no LLM call made.
 */
export class InputValidationError extends Data.TaggedError("InputValidationError")<{
  readonly runId: string;
  readonly agentId: string;
  readonly issues: ReadonlyArray<{ path: string; message: string }>;
}> {}

/**
 * Output failed `outputSchema` decode after the retry budget was exhausted.
 * The last attempt's raw text is preserved so callers can surface it.
 */
export class OutputValidationError extends Data.TaggedError("OutputValidationError")<{
  readonly runId: string;
  readonly agentId: string;
  readonly attempts: number;
  readonly lastIssues: ReadonlyArray<{ path: string; message: string }>;
  readonly lastText: string;
}> {}

/**
 * Subagent spawn rejected by `taskTool` enforcement — depth or fan-out
 * exceeded, or `agent_type` not in the parent's `subagents.allowed`.
 */
export class SubagentLimitError extends Data.TaggedError("SubagentLimitError")<{
  readonly runId: string;
  readonly reason: "depth" | "fan_out" | "not_allowed";
  readonly attempted: string;
}> {}

/**
 * A run budget was exhausted without producing a valid output. `dimension`
 * identifies which limit tripped; `limit` is the configured ceiling and
 * `observed` the value that breached it (turn count, elapsed ms, or USD).
 */
export class QuotaExceededError extends Data.TaggedError("QuotaExceededError")<{
  readonly runId: string;
  readonly dimension: "turns" | "duration" | "cost";
  readonly limit: number;
  readonly observed: number;
}> {}

/** Caller-initiated cancellation via `AbortSignal`. */
export class CancelledError extends Data.TaggedError("CancelledError")<{
  readonly runId: string;
}> {}

/** Run is suspended waiting on a user confirmation (confirm-gate plugin). */
export class PausedForConfirmationError extends Data.TaggedError("PausedForConfirmationError")<{
  readonly runId: string;
  readonly toolUseId: string;
  readonly toolName: string;
}> {}

/** Model layer failures: routing miss, breaker open, provider 5xx, etc. */
export class ModelError extends Data.TaggedError("ModelError")<{
  readonly runId: string;
  readonly modelName: string;
  readonly reason: "routing_miss" | "circuit_open" | "rate_limited" | "provider_error" | "auth";
  readonly message: string;
}> {}

/** Sandbox refused or failed a tool-side filesystem/exec operation. */
export class SandboxError extends Data.TaggedError("SandboxError")<{
  readonly runId: string;
  readonly op: "exec" | "read" | "write";
  readonly path?: string;
  readonly message: string;
}> {}

/** Storage adapter failure — persistence layer cannot record or recover. */
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly runId: string;
  readonly op: string;
  readonly message: string;
}> {}

/** A `HarnessPlugin` hook threw or returned an invalid decision. */
export class PluginError extends Data.TaggedError("PluginError")<{
  readonly runId: string;
  readonly pluginId: string;
  readonly hook: string;
  readonly message: string;
}> {}

/** Memory adapter failure — read/write/search against the memory store. */
export class MemoryError extends Data.TaggedError("MemoryError")<{
  readonly op: "put" | "get" | "search" | "list" | "forget" | "close" | "init";
  readonly reason: "not_found" | "invalid_scope" | "path_escape" | "io" | "invalid_id";
  readonly message: string;
  readonly id?: string;
}> {}

/**
 * A deterministic lifecycle step (`init` / `postSuccess`) failed — referenced
 * a command/skill outside the agent's allowlist or missing from the registry,
 * or a host-side MCP call threw.
 */
export class LifecycleError extends Data.TaggedError("LifecycleError")<{
  readonly runId: string;
  readonly phase: "init" | "postSuccess";
  /** The offending step, e.g. `command:setup` or `mcp:github__list_issues`. */
  readonly step: string;
  readonly message: string;
}> {}

/**
 * A `spec.compaction` policy is internally inconsistent — e.g. it lists the
 * `summarize` strategy but provides no `summaryPrompt`. Caught at run start
 * (fast-fail, no LLM call), not at the first compaction pass. Distinct from a
 * runtime summariser failure, which is non-fatal: that surfaces as an `error`
 * event tagged `"CompactionError"` and the run continues uncompacted.
 */
export class CompactionConfigError extends Data.TaggedError("CompactionConfigError")<{
  readonly runId: string;
  readonly agentId: string;
  readonly message: string;
}> {}

/**
 * Discriminated union of every error a run can fail with.
 * Effect surface uses this as the error channel: `Effect<RunResult, HarnessError, R>`.
 */
export type HarnessError =
  | InputValidationError
  | OutputValidationError
  | SubagentLimitError
  | QuotaExceededError
  | CancelledError
  | PausedForConfirmationError
  | ModelError
  | SandboxError
  | StorageError
  | PluginError
  | MemoryError
  | LifecycleError
  | CompactionConfigError;
