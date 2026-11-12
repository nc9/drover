/**
 * #97 review (H1): a retried or reclaimed job runs each attempt under its own run id, so the
 * loud duplicate-createRun check never fails a retry, and the job points at the attempt that
 * ended it. The provider is a stand-in `globalThis.fetch` (the worker pool resolves models
 * itself, from the environment), restored after each test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import { createMemoryStorage } from "@droveragent/storage";

import {
  attemptRunId,
  createLibsqlQueue,
  createMemoryQueue,
  createWorkerPool,
  type QueueAdapter,
} from "../src/index.ts";

const spec = defineAgent({
  id: "worker-probe",
  systemPrompt: "probe",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Unknown(),
  model: "openrouter:openai/gpt-5-mini",
  tools: [],
});
const registry = { resolve: (id: string) => (id === spec.id ? spec : undefined) };

const sseOk = (text: string) =>
  new Response(
    [
      `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

let savedFetch: typeof fetch;
let savedKey: string | undefined;
/** Provider answers, in order: each call takes the next one (the last one repeats). */
const answers: Array<() => Response> = [];
let calls = 0;
beforeEach(() => {
  savedFetch = globalThis.fetch;
  savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  calls = 0;
  answers.length = 0;
  globalThis.fetch = (async () => {
    const a = answers[Math.min(calls, answers.length - 1)]!;
    calls += 1;
    return a();
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;
});

async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
}

const queues: Array<[string, () => Promise<QueueAdapter>]> = [
  ["memory", async () => createMemoryQueue()],
  ["libsql", async () => createLibsqlQueue({ url: ":memory:" })],
];

describe("attemptRunId", () => {
  test("attempt 1 keeps run_<job>; later attempts add _a<n>, never ':'", () => {
    expect(attemptRunId({ id: "j", attempts: 0 })).toBe("run_j");
    expect(attemptRunId({ id: "j", attempts: 1 })).toBe("run_j_a2");
    expect(attemptRunId({ id: "j", attempts: 4 })).toBe("run_j_a5");
  });
});

for (const [name, makeQueue] of queues) {
  describe(`worker pool attempts (${name} queue)`, () => {
    test("a provider failure then success: two runs, the job done on the second attempt's run", async () => {
      // A 400: the provider SDK retries a 5xx itself inside one attempt, so a single 500 would
      // not fail the attempt. The worker-level retry is what this test is about.
      answers.push(
        () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 400 }),
        () => sseOk("second attempt answer"),
      );
      const queue = await makeQueue();
      const storage = createMemoryStorage();
      await Effect.runPromise(
        queue.enqueue({ id: "j1", agentId: spec.id, input: { q: "x" }, maxAttempts: 3 }),
      );
      const pool = createWorkerPool(
        { queue, storage, registry, sandboxFor: () => createNoneSandbox() },
        { pollIntervalMs: 10, reclaimIntervalMs: 60_000, retryOnFailure: true },
      );
      pool.start();
      try {
        await until(async () => {
          const j = await Effect.runPromise(queue.get("j1"));
          return j?.status === "done" || j?.status === "failed";
        });
      } finally {
        await pool.stop();
      }
      const job = await Effect.runPromise(queue.get("j1"));
      expect(job).toMatchObject({ status: "done", attempts: 1, runId: "run_j1_a2" });
      const first = await Effect.runPromise(storage.loadRun("run_j1"));
      const second = await Effect.runPromise(storage.loadRun("run_j1_a2"));
      expect(first?.status).toBe("error");
      expect(second?.status).toBe("success");
      expect(second?.output).toBe(undefined); // open schema: success carries no decoded output
    });

    test("a job that fails on every attempt points at its last attempt's run", async () => {
      answers.push(
        () => new Response(JSON.stringify({ error: { message: "x" } }), { status: 400 }),
      );
      const queue = await makeQueue();
      const storage = createMemoryStorage();
      await Effect.runPromise(
        queue.enqueue({ id: "j2", agentId: spec.id, input: { q: "x" }, maxAttempts: 2 }),
      );
      const pool = createWorkerPool(
        { queue, storage, registry, sandboxFor: () => createNoneSandbox() },
        { pollIntervalMs: 10, reclaimIntervalMs: 60_000, retryOnFailure: true },
      );
      pool.start();
      try {
        await until(async () => (await Effect.runPromise(queue.get("j2")))?.status === "failed");
      } finally {
        await pool.stop();
      }
      const job = await Effect.runPromise(queue.get("j2"));
      expect(job).toMatchObject({ status: "failed", attempts: 2, runId: "run_j2_a2" });
      expect((await Effect.runPromise(storage.loadRun("run_j2")))?.status).toBe("error");
      expect((await Effect.runPromise(storage.loadRun("run_j2_a2")))?.status).toBe("error");
    });

    test("a reclaimed lease: the next attempt does not collide with the crashed attempt's run", async () => {
      answers.push(() => sseOk("after reclaim"));
      const queue = await makeQueue();
      const storage = createMemoryStorage();
      await Effect.runPromise(
        queue.enqueue({ id: "j3", agentId: spec.id, input: { q: "x" }, maxAttempts: 3 }),
      );
      // Attempt 1: a worker claims the job, creates its run, and dies (lease runs out).
      const claimed = await Effect.runPromise(queue.claim("dead-worker", 1));
      expect(claimed?.job.id).toBe("j3");
      await Effect.runPromise(
        storage.createRun({
          id: "run_j3",
          agentId: spec.id,
          specHash: "h",
          status: "running",
          input: { q: "x" },
          startedAt: 1,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
        }),
      );
      await new Promise((r) => setTimeout(r, 5));
      expect(await Effect.runPromise(queue.reclaimStale(Date.now()))).toBe(1);
      const pool = createWorkerPool(
        { queue, storage, registry, sandboxFor: () => createNoneSandbox() },
        { pollIntervalMs: 10, reclaimIntervalMs: 60_000, retryOnFailure: true },
      );
      pool.start();
      try {
        await until(async () => {
          const j = await Effect.runPromise(queue.get("j3"));
          return j?.status === "done" || j?.status === "failed";
        });
      } finally {
        await pool.stop();
      }
      const job = await Effect.runPromise(queue.get("j3"));
      expect(job).toMatchObject({ status: "done", runId: "run_j3_a2" });
      // The crashed attempt's row is left as it was; the new attempt has its own.
      expect((await Effect.runPromise(storage.loadRun("run_j3")))?.status).toBe("running");
      expect((await Effect.runPromise(storage.loadRun("run_j3_a2")))?.status).toBe("success");
    });
  });
}
