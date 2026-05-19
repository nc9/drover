import type { HarnessEvent, RunStatus, Usage } from "@drover/core";
import { StorageError } from "@drover/core";
import type { Effect } from "effect";

/** Persisted run record. Mirrors the `runs` table. */
export interface RunRow {
  id: string;
  parentRunId?: string;
  agentId: string;
  specHash: string;
  status: RunStatus | "running";
  /** JSON-encoded TypeBox-validated input. */
  input: unknown;
  /** JSON-encoded TypeBox-validated output. Undefined until success. */
  output?: unknown;
  error?: { tag: string; message: string };
  startedAt: number;
  endedAt?: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Free-form propagated tags (orgId, websiteId, …). */
  meta?: Record<string, unknown>;
}

/** One persisted event row. seq is per-run monotonic. */
export interface EventRow {
  runId: string;
  seq: number;
  ts: number;
  kind: HarnessEvent["kind"];
  /** The event itself — full HarnessEvent JSON. */
  payload: HarnessEvent;
}

/**
 * Post-turn checkpoint snapshot. State opaque to drover — the harness
 * round-trips pi's message list plus its own cumulative accumulators.
 * Resume reconstructs context from this.
 */
export interface CheckpointRow {
  runId: string;
  seq: number;
  /** Snapshot of pi's `AgentMessage[]` for resume — opaque to storage. */
  messages: unknown;
  usage: Usage;
  /** Tool ids invoked so far, in order. */
  toolCalls: ReadonlyArray<string>;
  /** Cumulative output-retry counter. */
  retriesUsed: number;
  ts: number;
}

/** Confirm-gate state. One row per outstanding require_confirm decision. */
export interface PendingConfirmationRow {
  runId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  reason: string;
  createdAt: number;
  resolvedAt?: number;
  /** Caller-supplied resolution. `null` = denied, anything else = result content. */
  result?: unknown;
}

/** Optional filter for `listRuns`. */
export interface RunListFilter {
  status?: ReadonlyArray<RunRow["status"]>;
  agentId?: string;
  parentRunId?: string | null;
  /** ISO timestamp lower bound. */
  startedAfter?: number;
  limit?: number;
  offset?: number;
}

/**
 * Pluggable persistence boundary. Default impl is libsql; consumers
 * with their own ORM (Drizzle, Prisma) or runtime (D1, etc.) plug their
 * own adapter. Every method returns Effect for uniform error handling.
 *
 * Append-only contract: `appendEvent` MUST persist in seq order;
 * concurrent runs are isolated by runId. Implementations decide
 * whether seq is per-run-monotonic (counter in adapter) or caller-
 * supplied — drover's harness supplies seq.
 */
export interface StorageAdapter {
  readonly id: string;
  createRun(row: RunRow): Effect.Effect<void, StorageError, never>;
  updateRun(
    id: string,
    patch: Partial<Omit<RunRow, "id" | "agentId" | "specHash" | "input" | "startedAt">>,
  ): Effect.Effect<void, StorageError, never>;
  appendEvent(event: EventRow): Effect.Effect<void, StorageError, never>;
  saveCheckpoint(checkpoint: CheckpointRow): Effect.Effect<void, StorageError, never>;
  loadRun(id: string): Effect.Effect<RunRow | null, StorageError, never>;
  loadLatestCheckpoint(
    runId: string,
  ): Effect.Effect<CheckpointRow | null, StorageError, never>;
  listEvents(runId: string): Effect.Effect<ReadonlyArray<EventRow>, StorageError, never>;
  listRuns(filter?: RunListFilter): Effect.Effect<ReadonlyArray<RunRow>, StorageError, never>;
  createPendingConfirmation(
    row: PendingConfirmationRow,
  ): Effect.Effect<void, StorageError, never>;
  resolvePendingConfirmation(
    runId: string,
    toolUseId: string,
    result: unknown,
    resolvedAt: number,
  ): Effect.Effect<void, StorageError, never>;
  /** Best-effort dispose: close DB handles, etc. */
  close(): Effect.Effect<void, StorageError, never>;
}
