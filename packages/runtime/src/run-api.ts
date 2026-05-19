import { Effect } from "effect";
import type { RunResult } from "@drover/core";
import { resumeAgent, type AgentRegistry } from "@drover/facade";
import type { SandboxAdapter } from "@drover/sandbox";
import type { RunRow, StorageAdapter } from "@drover/storage";

import type { QueueAdapter, QueueJob, EnqueueInput } from "./queue/adapter.ts";

/**
 * Programmatic API for callers (HTTP handlers, CLIs, other agents) to
 * drive the runtime without coupling to the worker pool. The pool is
 * the consumer of `queue.claim`; this API is the producer.
 *
 * `waitFor` and `resume` go through storage, so they work even when
 * the original enqueue happened in a different process.
 */
export interface RunApi {
  /** Enqueue a fresh job. Returns the queue row. */
  enqueue(input: EnqueueInput): Promise<QueueJob>;
  /** Combined queue + run snapshot. */
  get(jobId: string): Promise<{ job: QueueJob | null; run: RunRow | null }>;
  cancel(jobId: string): Promise<void>;
  /**
   * Resume a paused run. Requires the spec to be in the registry. The
   * run is executed inline — caller awaits the RunResult — because pause/
   * resume is a control-plane operation, not a background job.
   */
  resume(jobId: string): Promise<RunResult<unknown>>;
  /**
   * Wait for the job to reach a terminal status. Polls `pollIntervalMs`
   * (default 200ms). Returns the final queue + run state.
   */
  waitFor(
    jobId: string,
    opts?: { pollIntervalMs?: number; timeoutMs?: number },
  ): Promise<{ job: QueueJob; run: RunRow | null }>;
  /** List queued/leased/done jobs. Thin pass-through. */
  list(filter?: Parameters<QueueAdapter["list"]>[0]): Promise<ReadonlyArray<QueueJob>>;
}

export interface RunApiDeps {
  queue: QueueAdapter;
  storage: StorageAdapter;
  registry: AgentRegistry;
  /** Sandbox to use when `resume` is called. Caller-owned. */
  sandboxFor: (job: QueueJob) => SandboxAdapter | Promise<SandboxAdapter>;
  /**
   * Plugins that match what the worker pool injected on the original
   * run. They're hashed into the effective spec — omitting them on
   * resume produces a spec-hash mismatch and rejects the resume. Mirror
   * your `WorkerPoolDeps.plugins` value here.
   */
  plugins?: ReadonlyArray<import("@drover/core").HarnessPlugin>;
}

const TERMINAL_QUEUE: ReadonlySet<QueueJob["status"]> = new Set([
  "done",
  "failed",
  "cancelled",
]);

export function createRunApi(deps: RunApiDeps): RunApi {
  return {
    enqueue: async (input) => {
      return await Effect.runPromise(deps.queue.enqueue(input));
    },
    get: async (jobId) => {
      const job = await Effect.runPromise(deps.queue.get(jobId));
      const run = job?.runId
        ? await Effect.runPromise(deps.storage.loadRun(job.runId))
        : null;
      return { job, run };
    },
    cancel: async (jobId) => {
      await Effect.runPromise(deps.queue.cancel(jobId));
    },
    resume: async (jobId) => {
      const job = await Effect.runPromise(deps.queue.get(jobId));
      if (!job) {
        return runErrorResult(jobId, "ResumeError", `job ${jobId} not found`);
      }
      if (!job.runId) {
        return runErrorResult(jobId, "ResumeError", "job has no associated run");
      }
      const spec = deps.registry.resolve(job.agentId);
      if (!spec) {
        return runErrorResult(
          job.runId,
          "ResumeError",
          `agent ${job.agentId} not in registry`,
        );
      }
      const sandbox = await deps.sandboxFor(job);
      const handle = resumeAgent(spec, job.runId, {
        storage: deps.storage,
        agentRegistry: deps.registry,
        sandbox,
        ...(deps.plugins ? { plugins: deps.plugins } : {}),
      });
      // Drain events to completion.
      (async (): Promise<void> => {
        for await (const _ of handle.events) void _;
      })().catch(() => {});
      const result = await handle.result;
      // We deliberately do NOT mutate the queue row here. The queue's
      // `done` state reflects the original worker-driven run; the
      // post-resume status lives on the storage `runs` row. Mutating
      // the queue row would also fight the lease guard (the queue row
      // has no live lease — resume runs out-of-band).
      return result;
    },
    waitFor: async (jobId, opts) => {
      const pollMs = opts?.pollIntervalMs ?? 200;
      const timeoutMs = opts?.timeoutMs ?? 5 * 60_000;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const job = await Effect.runPromise(deps.queue.get(jobId));
        if (!job) {
          throw new Error(`waitFor: job ${jobId} not found`);
        }
        if (TERMINAL_QUEUE.has(job.status)) {
          const run = job.runId
            ? await Effect.runPromise(deps.storage.loadRun(job.runId))
            : null;
          return { job, run };
        }
        await sleep(pollMs);
      }
      throw new Error(`waitFor: timed out after ${timeoutMs}ms waiting for ${jobId}`);
    },
    list: async (filter) => {
      return await Effect.runPromise(deps.queue.list(filter));
    },
  };
}

function runErrorResult(
  runId: string,
  tag: string,
  message: string,
): RunResult<unknown> {
  return {
    runId,
    status: "error",
    finalText: "",
    turns: 0,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    toolCalls: [],
    error: { tag, message },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
