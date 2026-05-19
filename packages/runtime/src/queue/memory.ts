import { Effect } from "effect";
import type { RunStatus } from "@drover/core";

import {
  type ClaimedJob,
  type EnqueueInput,
  type QueueAdapter,
  QueueError,
  type QueueJob,
  type QueueListFilter,
} from "./adapter.ts";

/**
 * In-process memory queue. Lifetime is one process — crash = lost. Good
 * for tests, the eval suite, and any app that owns its own scheduler
 * loop and doesn't need cross-process coordination.
 *
 * `claim` is synchronous Map iteration; concurrency is bounded by the
 * fact that we're single-threaded inside one event loop, so the "atomic
 * leasing" contract collapses to "no two awaits can interleave inside
 * the synchronous claim step." For multi-process work use libsql.
 */
export function createMemoryQueue(): QueueAdapter {
  const jobs = new Map<string, QueueJob>();
  const cancelled = new Set<string>();

  const fresh = (input: EnqueueInput): QueueJob => ({
    id: input.id,
    agentId: input.agentId,
    input: input.input,
    ...(input.meta ? { meta: input.meta } : {}),
    priority: input.priority ?? 0,
    scheduledFor: input.scheduledFor ?? null,
    status: "queued",
    leaseWorker: null,
    leaseExpiresAt: null,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 1,
    createdAt: Date.now(),
    runId: null,
    resultStatus: null,
    resultError: null,
  });

  return {
    id: "memory",
    enqueue: (input) =>
      Effect.suspend(() => {
        if (jobs.has(input.id)) {
          return Effect.fail(
            new QueueError({ op: "enqueue", message: `duplicate id ${input.id}` }),
          );
        }
        const job = fresh(input);
        jobs.set(job.id, job);
        return Effect.succeed(job);
      }),
    claim: (workerId, leaseDurationMs) =>
      Effect.sync((): ClaimedJob | null => {
        const now = Date.now();
        // Highest priority, then oldest, among ready jobs.
        let best: QueueJob | null = null;
        for (const j of jobs.values()) {
          if (j.status !== "queued") continue;
          if (j.scheduledFor !== null && j.scheduledFor > now) continue;
          if (
            !best ||
            j.priority > best.priority ||
            (j.priority === best.priority && j.createdAt < best.createdAt)
          ) {
            best = j;
          }
        }
        if (!best) return null;
        const leaseExpiresAt = now + leaseDurationMs;
        best.status = "leased";
        best.leaseWorker = workerId;
        best.leaseExpiresAt = leaseExpiresAt;
        return { job: { ...best }, leaseExpiresAt };
      }),
    heartbeat: (jobId, workerId, leaseDurationMs) =>
      Effect.suspend(() => {
        const j = jobs.get(jobId);
        if (!j) return Effect.fail(new QueueError({ op: "heartbeat", message: "not found" }));
        if (j.status !== "leased" || j.leaseWorker !== workerId) {
          return Effect.fail(
            new QueueError({ op: "heartbeat", message: "lease no longer held" }),
          );
        }
        j.leaseExpiresAt = Date.now() + leaseDurationMs;
        return Effect.void;
      }),
    complete: (jobId, workerId, runId, status) =>
      Effect.suspend(() => {
        const j = jobs.get(jobId);
        if (!j) return Effect.fail(new QueueError({ op: "complete", message: "not found" }));
        // Lost-lease guard: silently no-op if another worker took over.
        if (j.status !== "leased" || j.leaseWorker !== workerId) {
          return Effect.succeed(false);
        }
        j.status = "done";
        j.runId = runId;
        j.resultStatus = status;
        j.leaseWorker = null;
        j.leaseExpiresAt = null;
        return Effect.succeed(true);
      }),
    fail: (jobId, workerId, error, retry) =>
      Effect.suspend(() => {
        const j = jobs.get(jobId);
        if (!j) return Effect.fail(new QueueError({ op: "fail", message: "not found" }));
        // Lost-lease guard.
        if (j.status !== "leased" || j.leaseWorker !== workerId) {
          return Effect.succeed(false);
        }
        j.attempts += 1;
        j.leaseWorker = null;
        j.leaseExpiresAt = null;
        j.resultError = error;
        if (retry && j.attempts < j.maxAttempts) {
          j.status = "queued";
        } else {
          j.status = "failed";
        }
        return Effect.succeed(true);
      }),
    cancel: (jobId) =>
      Effect.suspend(() => {
        const j = jobs.get(jobId);
        if (!j) return Effect.fail(new QueueError({ op: "cancel", message: "not found" }));
        cancelled.add(jobId);
        if (j.status === "queued") {
          // Easy case: never started, terminal immediately.
          j.status = "cancelled";
          j.leaseWorker = null;
          j.leaseExpiresAt = null;
        }
        // If "leased" or "done"/"failed", let the worker observe via cancelRequested.
        return Effect.void;
      }),
    cancelRequested: (jobId) => Effect.sync(() => cancelled.has(jobId)),
    reclaimStale: (now) =>
      Effect.sync(() => {
        let n = 0;
        for (const j of jobs.values()) {
          if (j.status !== "leased") continue;
          if (j.leaseExpiresAt !== null && j.leaseExpiresAt < now) {
            j.attempts += 1;
            j.leaseWorker = null;
            j.leaseExpiresAt = null;
            // Honour maxAttempts: jobs that have expired enough times
            // move to terminal `failed` instead of spinning in the
            // reclaim loop forever.
            if (j.attempts >= j.maxAttempts) {
              j.status = "failed";
              j.resultError = {
                tag: "LeaseExpired",
                message: `lease expired ${j.attempts} times; exceeded maxAttempts=${j.maxAttempts}`,
              };
            } else {
              j.status = "queued";
            }
            n += 1;
          }
        }
        return n;
      }),
    get: (jobId) => Effect.sync(() => jobs.get(jobId) ?? null),
    list: (filter?: QueueListFilter) =>
      Effect.sync((): ReadonlyArray<QueueJob> => {
        let out = Array.from(jobs.values());
        if (filter?.status?.length) {
          const set = new Set(filter.status);
          out = out.filter((j) => set.has(j.status));
        }
        if (filter?.agentId) out = out.filter((j) => j.agentId === filter.agentId);
        out.sort((a, b) => b.createdAt - a.createdAt);
        const offset = filter?.offset ?? 0;
        const limit = filter?.limit ?? out.length;
        return out.slice(offset, offset + limit);
      }),
    close: () => Effect.void,
  };

  // exhaustiveness check for RunStatus typing import
  void (null as unknown as RunStatus);
}
