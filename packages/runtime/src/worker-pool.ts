import { Effect } from "effect";
import { runAgent, type AgentRegistry } from "@drover/facade";
import type { AgentSpec, HarnessEvent, HarnessPlugin, RunResult } from "@drover/core";
import type { SandboxAdapter } from "@drover/sandbox";
import type { StorageAdapter } from "@drover/storage";

import type { QueueAdapter, QueueJob } from "./queue/adapter.ts";

/**
 * Inputs the worker pool needs to actually execute a job:
 *   - the queue to claim from
 *   - the storage where runs/events/checkpoints persist
 *   - an AgentRegistry mapping `job.agentId` → live `AgentSpec`
 *   - a sandbox factory (one fresh sandbox per job) so cwd/allowedRoots
 *     can be derived per-run (e.g. a tmp dir per job)
 *   - optional model alias overrides, mcp runtime, skill registry, plugins
 */
export interface WorkerPoolDeps {
  queue: QueueAdapter;
  storage: StorageAdapter;
  registry: AgentRegistry;
  /**
   * Build the sandbox for a specific job. Letting the caller decide gives
   * full control over per-job cwd / allowedRoots / shell capability.
   */
  sandboxFor: (job: QueueJob) => SandboxAdapter | Promise<SandboxAdapter>;
  /** Optional hook to read each event during a job — observability. */
  onEvent?: (job: QueueJob, event: HarnessEvent) => void;
  /** Extra plugins applied to every run. */
  plugins?: ReadonlyArray<HarnessPlugin>;
}

export interface WorkerPoolOptions {
  /** Worker identifier prefix; each worker appends a slot index. */
  workerIdPrefix?: string;
  /** Number of concurrent workers in the pool. Default 1. */
  concurrency?: number;
  /** Idle poll interval. Default 200ms. */
  pollIntervalMs?: number;
  /** Initial lease window. Default 30s. */
  leaseDurationMs?: number;
  /** Heartbeat interval. Must be < leaseDurationMs. Default leaseDurationMs/3. */
  heartbeatIntervalMs?: number;
  /** Re-queue jobs whose lease has expired. Default every 5s. */
  reclaimIntervalMs?: number;
  /** Re-queue on failure by default. */
  retryOnFailure?: boolean;
}

export interface WorkerPoolHandle {
  /** Start polling. Idempotent. */
  start(): void;
  /** Stop polling + abort in-flight jobs + drain. Awaits all workers. */
  stop(): Promise<void>;
  /** Stats snapshot for observability. */
  stats(): { running: number; processed: number; failed: number };
}

/**
 * Single-process worker pool. Each worker runs a poll → claim →
 * heartbeat → execute → complete loop. Heartbeats keep the lease alive
 * while pi-agent-core's run is in progress; if a worker crashes the
 * lease expires and `reclaimStale` re-queues the job.
 *
 * Concurrency is capped by `concurrency`; jobs above the cap simply
 * wait in the queue. For horizontal scaling, point multiple pools
 * (e.g. across processes / machines) at the same `libsql` queue —
 * the atomic `claim` ensures no two pools pick up the same job.
 */
export function createWorkerPool(
  deps: WorkerPoolDeps,
  opts: WorkerPoolOptions = {},
): WorkerPoolHandle {
  const prefix = opts.workerIdPrefix ?? `worker-${shortId()}`;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const pollIntervalMs = opts.pollIntervalMs ?? 200;
  const leaseDurationMs = opts.leaseDurationMs ?? 30_000;
  const heartbeatIntervalMs = Math.min(
    opts.heartbeatIntervalMs ?? Math.floor(leaseDurationMs / 3),
    Math.floor(leaseDurationMs / 2),
  );
  const reclaimIntervalMs = opts.reclaimIntervalMs ?? 5_000;
  const retryOnFailure = opts.retryOnFailure ?? true;

  let running = false;
  let inFlight = 0;
  let processed = 0;
  let failed = 0;
  const ac = new AbortController();
  const workerPromises: Promise<void>[] = [];

  const workerLoop = async (workerId: string): Promise<void> => {
    while (running && !ac.signal.aborted) {
      let claimed: { job: QueueJob; leaseExpiresAt: number } | null = null;
      try {
        const r = await Effect.runPromise(
          Effect.either(deps.queue.claim(workerId, leaseDurationMs)),
        );
        claimed = r._tag === "Right" ? r.right : null;
      } catch {
        claimed = null;
      }

      if (!claimed) {
        await sleep(pollIntervalMs, ac.signal);
        continue;
      }

      inFlight += 1;
      try {
        await executeJob(workerId, claimed.job, deps, {
          heartbeatIntervalMs,
          leaseDurationMs,
          retryOnFailure,
          poolSignal: ac.signal,
        });
        processed += 1;
      } catch {
        failed += 1;
      } finally {
        inFlight -= 1;
      }
    }
  };

  const reclaimLoop = async (): Promise<void> => {
    while (running && !ac.signal.aborted) {
      try {
        await Effect.runPromise(Effect.either(deps.queue.reclaimStale(Date.now())));
      } catch {
        // Reclaim failure shouldn't kill the loop — try again next tick.
      }
      await sleep(reclaimIntervalMs, ac.signal);
    }
  };

  return {
    start: (): void => {
      if (running) return;
      running = true;
      for (let i = 0; i < concurrency; i++) {
        workerPromises.push(workerLoop(`${prefix}-${i}`));
      }
      workerPromises.push(reclaimLoop());
    },
    stop: async (): Promise<void> => {
      running = false;
      ac.abort();
      await Promise.allSettled(workerPromises);
      workerPromises.length = 0;
    },
    stats: () => ({ running: inFlight, processed, failed }),
  };
}

async function executeJob(
  workerId: string,
  job: QueueJob,
  deps: WorkerPoolDeps,
  opts: {
    heartbeatIntervalMs: number;
    leaseDurationMs: number;
    retryOnFailure: boolean;
    poolSignal: AbortSignal;
  },
): Promise<void> {
  const spec = deps.registry.resolve(job.agentId);
  if (!spec) {
    await Effect.runPromise(
      Effect.either(
        deps.queue.fail(
          job.id,
          workerId,
          { tag: "UnknownAgent", message: `agent ${job.agentId} not in registry` },
          /* retry */ false,
        ),
      ),
    );
    return;
  }

  const sandbox = await deps.sandboxFor(job);
  const cancelSource = new AbortController();
  // Propagate pool shutdown into the run.
  const onPoolAbort = (): void => cancelSource.abort();
  if (opts.poolSignal.aborted) cancelSource.abort();
  else opts.poolSignal.addEventListener("abort", onPoolAbort, { once: true });

  // Heartbeat loop. Stops on success/failure of the run.
  let alive = true;
  const heartbeat = async (): Promise<void> => {
    while (alive && !cancelSource.signal.aborted) {
      await sleep(opts.heartbeatIntervalMs, cancelSource.signal);
      if (!alive) break;
      try {
        await Effect.runPromise(
          deps.queue.heartbeat(job.id, workerId, opts.leaseDurationMs),
        );
      } catch {
        // Lost the lease (likely reclaimed). Abort the run so we don't
        // double-execute alongside whoever picked it up next.
        cancelSource.abort();
      }
    }
  };
  const hb = heartbeat();

  // Cancellation polling — workers respect caller-initiated cancels.
  const cancelPoll = (async (): Promise<void> => {
    while (alive && !cancelSource.signal.aborted) {
      await sleep(Math.min(opts.heartbeatIntervalMs, 1000), cancelSource.signal);
      if (!alive) break;
      try {
        const r = await Effect.runPromise(deps.queue.cancelRequested(job.id));
        if (r) cancelSource.abort();
      } catch {
        /* ignore */
      }
    }
  })();

  let result: RunResult<unknown> | null = null;
  let runError: { tag: string; message: string } | null = null;
  try {
    const handle = runAgent(spec as AgentSpec, job.input as never, {
      runId: job.runId ?? `run_${job.id}`,
      storage: deps.storage,
      agentRegistry: deps.registry,
      sandbox,
      signal: cancelSource.signal,
      ...(deps.plugins ? { plugins: deps.plugins } : {}),
      ...(job.meta ? { meta: job.meta as Record<string, unknown> } : {}),
    });

    if (deps.onEvent) {
      (async (): Promise<void> => {
        for await (const e of handle.events) deps.onEvent!(job, e);
      })().catch(() => {});
    } else {
      // Drain so the queue doesn't grow unbounded.
      (async (): Promise<void> => {
        for await (const _ of handle.events) void _;
      })().catch(() => {});
    }

    result = await handle.result;
  } catch (err) {
    runError = { tag: "WorkerError", message: (err as Error).message };
  } finally {
    alive = false;
    cancelSource.abort();
    opts.poolSignal.removeEventListener("abort", onPoolAbort);
    await Promise.allSettled([hb, cancelPoll]);
  }

  // Resolve the queue side based on RunResult. Every terminal write
  // passes `workerId` so the queue's lease guard can silently drop the
  // result when this worker has lost the lease (another worker now
  // owns the job after a reclaim).
  if (runError) {
    await Effect.runPromise(
      Effect.either(deps.queue.fail(job.id, workerId, runError, opts.retryOnFailure)),
    );
    return;
  }
  if (!result) {
    await Effect.runPromise(
      Effect.either(
        deps.queue.fail(
          job.id,
          workerId,
          { tag: "WorkerError", message: "no result returned" },
          opts.retryOnFailure,
        ),
      ),
    );
    return;
  }
  if (result.status === "success" || result.status === "paused") {
    await Effect.runPromise(
      Effect.either(deps.queue.complete(job.id, workerId, result.runId, result.status)),
    );
  } else if (result.status === "cancelled") {
    await Effect.runPromise(
      Effect.either(
        deps.queue.fail(
          job.id,
          workerId,
          result.error ?? { tag: "Cancelled", message: "cancelled" },
          /* retry */ false,
        ),
      ),
    );
  } else {
    await Effect.runPromise(
      Effect.either(
        deps.queue.fail(
          job.id,
          workerId,
          result.error ?? { tag: "Error", message: "run failed" },
          opts.retryOnFailure,
        ),
      ),
    );
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}
