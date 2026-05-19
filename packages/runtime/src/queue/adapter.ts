import type { RunStatus } from "@drover/core";
import { Data } from "effect";
import type { Effect } from "effect";

/**
 * One queued job. The agent itself isn't serialised — only the agent
 * id (resolved against the worker's registry) plus the input payload
 * and a few control knobs. This keeps the queue language-independent;
 * any agent that's registered on the worker can be enqueued from
 * anywhere (HTTP, webhook, CLI, another agent).
 */
export interface QueueJob {
  id: string;
  /** AgentRegistry key. */
  agentId: string;
  /** Validated input to the agent's `inputSchema` (stored as JSON). */
  input: unknown;
  /** Free-form propagated tags. */
  meta?: Readonly<Record<string, unknown>>;
  /** Higher = sooner. Ties broken by `createdAt`. Default 0. */
  priority: number;
  /** ms epoch the job is eligible to run. `null` = now. */
  scheduledFor: number | null;
  status: QueueJobStatus;
  /** Worker that leased the job, if any. */
  leaseWorker: string | null;
  /** ms epoch the lease expires. Used by `reclaimStale`. */
  leaseExpiresAt: number | null;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  /** Run row id once the worker creates it. */
  runId: string | null;
  /** Final `RunResult.status` once execution finishes. */
  resultStatus: RunStatus | null;
  resultError: { tag: string; message: string } | null;
}

export type QueueJobStatus =
  /** Eligible to be claimed. */
  | "queued"
  /** Claimed by a worker, lease active. */
  | "leased"
  /** Terminal — succeeded. */
  | "done"
  /** Terminal — exhausted attempts or final error. */
  | "failed"
  /** Terminal — caller cancelled before lease. */
  | "cancelled";

/** Input to `enqueue`. Everything else is set by the adapter. */
export interface EnqueueInput {
  /** Caller-supplied id. Use `crypto.randomUUID()` to avoid collisions. */
  id: string;
  agentId: string;
  input: unknown;
  meta?: Readonly<Record<string, unknown>>;
  priority?: number;
  scheduledFor?: number | null;
  maxAttempts?: number;
}

/** What `claim` returns. `null` = nothing to do. */
export interface ClaimedJob {
  job: QueueJob;
  /** Convenience: ms epoch when this lease will expire. */
  leaseExpiresAt: number;
}

/** Tagged queue errors. */
export class QueueError extends Data.TaggedError("QueueError")<{
  readonly op: string;
  readonly message: string;
}> {}

/** Filter for `list`. */
export interface QueueListFilter {
  status?: ReadonlyArray<QueueJobStatus>;
  agentId?: string;
  limit?: number;
  offset?: number;
}

/**
 * Pluggable queue boundary. Default impls: in-process memory (for tests
 * and single-process apps) + libsql (durable). Both honour the contract:
 *   - `claim` is atomic across workers — at most one worker leases a
 *     given job at a time.
 *   - `heartbeat` extends the lease; missing heartbeats let
 *     `reclaimStale` pull the job back.
 *   - `complete` / `fail` / `cancel` are terminal. Subsequent operations
 *     on a terminal job are no-ops.
 */
export interface QueueAdapter {
  readonly id: string;
  enqueue(input: EnqueueInput): Effect.Effect<QueueJob, QueueError, never>;
  /**
   * Try to claim the highest-priority eligible job. Returns `null` if
   * none ready. `leaseDurationMs` is added to `Date.now()` to set the
   * initial lease window — heartbeat to extend.
   */
  claim(
    workerId: string,
    leaseDurationMs: number,
  ): Effect.Effect<ClaimedJob | null, QueueError, never>;
  /** Extend a lease the caller already holds. */
  heartbeat(
    jobId: string,
    workerId: string,
    leaseDurationMs: number,
  ): Effect.Effect<void, QueueError, never>;
  /**
   * Mark a job done with the final run id + result status. **Lease-
   * guarded:** only applies when the caller still holds the lease
   * (status=leased AND lease_worker=workerId). Returns `true` when the
   * write landed, `false` when the lease was lost (caller should drop
   * the result silently — another worker now owns the job).
   */
  complete(
    jobId: string,
    workerId: string,
    runId: string,
    status: RunStatus,
  ): Effect.Effect<boolean, QueueError, never>;
  /**
   * Mark a job failed. Lease-guarded like `complete`. If
   * `attempts < maxAttempts` AND `retry === true`, implementations
   * re-queue (status="queued", clear lease) with incremented attempts;
   * otherwise mark "failed". Returns `true` when the write landed,
   * `false` on lost lease.
   */
  fail(
    jobId: string,
    workerId: string,
    error: { tag: string; message: string },
    retry: boolean,
  ): Effect.Effect<boolean, QueueError, never>;
  /**
   * Caller-initiated cancellation. Cancels queued + leased jobs; the
   * worker observes via `cancelRequested` or its own polling and aborts.
   */
  cancel(jobId: string): Effect.Effect<void, QueueError, never>;
  /** Whether a cancellation was requested for the given job. */
  cancelRequested(jobId: string): Effect.Effect<boolean, QueueError, never>;
  /** Worker-side: detach a stuck job after lease expiry. */
  reclaimStale(now: number): Effect.Effect<number, QueueError, never>;
  get(jobId: string): Effect.Effect<QueueJob | null, QueueError, never>;
  list(
    filter?: QueueListFilter,
  ): Effect.Effect<ReadonlyArray<QueueJob>, QueueError, never>;
  /** Optional dispose for adapters holding native resources. */
  close(): Effect.Effect<void, QueueError, never>;
}
