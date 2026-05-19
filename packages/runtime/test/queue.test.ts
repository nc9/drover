import { describe, test, expect } from "bun:test";
import { Effect } from "effect";

import { createMemoryQueue, createLibsqlQueue, type QueueAdapter } from "../src/index.ts";

const impls: Array<[string, () => Promise<QueueAdapter>]> = [
  ["memory", async () => createMemoryQueue()],
  ["libsql", async () => createLibsqlQueue({ url: ":memory:" })],
];

for (const [name, factory] of impls) {
  describe(`QueueAdapter (${name})`, () => {
    test("enqueue + get round-trip", async () => {
      const q = await factory();
      const job = await Effect.runPromise(
        q.enqueue({ id: "j1", agentId: "a", input: { x: 1 } }),
      );
      expect(job.id).toBe("j1");
      expect(job.status).toBe("queued");
      const loaded = await Effect.runPromise(q.get("j1"));
      expect(loaded?.input).toEqual({ x: 1 });
      await Effect.runPromise(q.close());
    });

    test("claim returns null when queue empty", async () => {
      const q = await factory();
      const r = await Effect.runPromise(q.claim("w1", 5000));
      expect(r).toBeNull();
      await Effect.runPromise(q.close());
    });

    test("claim flips status to leased", async () => {
      const q = await factory();
      await Effect.runPromise(q.enqueue({ id: "j2", agentId: "a", input: {} }));
      const claim = await Effect.runPromise(q.claim("w1", 5000));
      expect(claim?.job.status).toBe("leased");
      expect(claim?.job.leaseWorker).toBe("w1");
      await Effect.runPromise(q.close());
    });

    test("priority ordering (higher claimed first)", async () => {
      const q = await factory();
      await Effect.runPromise(q.enqueue({ id: "low", agentId: "a", input: {}, priority: 0 }));
      await Effect.runPromise(
        q.enqueue({ id: "high", agentId: "a", input: {}, priority: 10 }),
      );
      const first = await Effect.runPromise(q.claim("w1", 5000));
      expect(first?.job.id).toBe("high");
      await Effect.runPromise(q.close());
    });

    test("complete transitions to done with run id", async () => {
      const q = await factory();
      await Effect.runPromise(q.enqueue({ id: "j3", agentId: "a", input: {} }));
      await Effect.runPromise(q.claim("w1", 5000));
      const ok = await Effect.runPromise(q.complete("j3", "w1", "run-xyz", "success"));
      expect(ok).toBe(true);
      const loaded = await Effect.runPromise(q.get("j3"));
      expect(loaded?.status).toBe("done");
      expect(loaded?.runId).toBe("run-xyz");
      expect(loaded?.resultStatus).toBe("success");
      await Effect.runPromise(q.close());
    });

    test("complete from wrong worker is a no-op", async () => {
      const q = await factory();
      await Effect.runPromise(q.enqueue({ id: "j3b", agentId: "a", input: {} }));
      await Effect.runPromise(q.claim("w1", 5000));
      const ok = await Effect.runPromise(q.complete("j3b", "w2-stale", "run-xyz", "success"));
      expect(ok).toBe(false);
      const loaded = await Effect.runPromise(q.get("j3b"));
      expect(loaded?.status).toBe("leased");
      expect(loaded?.leaseWorker).toBe("w1");
      await Effect.runPromise(q.close());
    });

    test("fail re-queues when retry=true and attempts < max", async () => {
      const q = await factory();
      await Effect.runPromise(
        q.enqueue({ id: "j4", agentId: "a", input: {}, maxAttempts: 3 }),
      );
      await Effect.runPromise(q.claim("w1", 5000));
      const ok = await Effect.runPromise(q.fail("j4", "w1", { tag: "x", message: "y" }, true));
      expect(ok).toBe(true);
      const loaded = await Effect.runPromise(q.get("j4"));
      expect(loaded?.status).toBe("queued");
      expect(loaded?.attempts).toBe(1);
      await Effect.runPromise(q.close());
    });

    test("fail moves to failed when attempts >= max", async () => {
      const q = await factory();
      await Effect.runPromise(
        q.enqueue({ id: "j5", agentId: "a", input: {}, maxAttempts: 1 }),
      );
      await Effect.runPromise(q.claim("w1", 5000));
      await Effect.runPromise(q.fail("j5", "w1", { tag: "x", message: "y" }, true));
      const loaded = await Effect.runPromise(q.get("j5"));
      expect(loaded?.status).toBe("failed");
      await Effect.runPromise(q.close());
    });

    test("fail from wrong worker is a no-op", async () => {
      const q = await factory();
      await Effect.runPromise(q.enqueue({ id: "j5b", agentId: "a", input: {}, maxAttempts: 3 }));
      await Effect.runPromise(q.claim("w1", 5000));
      const ok = await Effect.runPromise(q.fail("j5b", "w2-stale", { tag: "x", message: "y" }, true));
      expect(ok).toBe(false);
      const loaded = await Effect.runPromise(q.get("j5b"));
      expect(loaded?.status).toBe("leased");
      expect(loaded?.attempts).toBe(0);
      await Effect.runPromise(q.close());
    });

    test("cancel on queued job is immediate", async () => {
      const q = await factory();
      await Effect.runPromise(q.enqueue({ id: "j6", agentId: "a", input: {} }));
      await Effect.runPromise(q.cancel("j6"));
      const loaded = await Effect.runPromise(q.get("j6"));
      expect(loaded?.status).toBe("cancelled");
      await Effect.runPromise(q.close());
    });

    test("cancelRequested true after cancel", async () => {
      const q = await factory();
      await Effect.runPromise(q.enqueue({ id: "j7", agentId: "a", input: {} }));
      await Effect.runPromise(q.cancel("j7"));
      const requested = await Effect.runPromise(q.cancelRequested("j7"));
      expect(requested).toBe(true);
      await Effect.runPromise(q.close());
    });

    test("reclaimStale re-queues expired leases under maxAttempts", async () => {
      const q = await factory();
      await Effect.runPromise(
        q.enqueue({ id: "j8", agentId: "a", input: {}, maxAttempts: 3 }),
      );
      // Lease with a 1ms window — already expired by the next tick.
      await Effect.runPromise(q.claim("w1", 1));
      await new Promise((r) => setTimeout(r, 5));
      const reclaimed = await Effect.runPromise(q.reclaimStale(Date.now()));
      expect(reclaimed).toBe(1);
      const loaded = await Effect.runPromise(q.get("j8"));
      expect(loaded?.status).toBe("queued");
      expect(loaded?.attempts).toBe(1);
      await Effect.runPromise(q.close());
    });

    test("reclaimStale moves jobs to failed when maxAttempts exhausted", async () => {
      const q = await factory();
      await Effect.runPromise(
        q.enqueue({ id: "j8b", agentId: "a", input: {}, maxAttempts: 1 }),
      );
      await Effect.runPromise(q.claim("w1", 1));
      await new Promise((r) => setTimeout(r, 5));
      const reclaimed = await Effect.runPromise(q.reclaimStale(Date.now()));
      expect(reclaimed).toBe(1);
      const loaded = await Effect.runPromise(q.get("j8b"));
      expect(loaded?.status).toBe("failed");
      expect(loaded?.resultError?.tag).toBe("LeaseExpired");
      await Effect.runPromise(q.close());
    });

    test("reclaimStale honours maxAttempts across multiple cycles", async () => {
      const q = await factory();
      await Effect.runPromise(
        q.enqueue({ id: "j8c", agentId: "a", input: {}, maxAttempts: 2 }),
      );
      // First expire cycle: re-queue, attempts=1.
      await Effect.runPromise(q.claim("w1", 1));
      await new Promise((r) => setTimeout(r, 5));
      await Effect.runPromise(q.reclaimStale(Date.now()));
      let loaded = await Effect.runPromise(q.get("j8c"));
      expect(loaded?.status).toBe("queued");
      expect(loaded?.attempts).toBe(1);

      // Second expire cycle: failed, attempts=2.
      await Effect.runPromise(q.claim("w1", 1));
      await new Promise((r) => setTimeout(r, 5));
      await Effect.runPromise(q.reclaimStale(Date.now()));
      loaded = await Effect.runPromise(q.get("j8c"));
      expect(loaded?.status).toBe("failed");
      expect(loaded?.attempts).toBe(2);
      await Effect.runPromise(q.close());
    });

    test("heartbeat extends lease for the holder", async () => {
      const q = await factory();
      await Effect.runPromise(q.enqueue({ id: "j9", agentId: "a", input: {} }));
      await Effect.runPromise(q.claim("w1", 100));
      // Heartbeat from the holder extends without error
      await Effect.runPromise(q.heartbeat("j9", "w1", 5000));
      await Effect.runPromise(q.close());
    });

    test("heartbeat fails for non-holders", async () => {
      const q = await factory();
      await Effect.runPromise(q.enqueue({ id: "j10", agentId: "a", input: {} }));
      await Effect.runPromise(q.claim("w1", 5000));
      const r = await Effect.runPromise(
        Effect.either(q.heartbeat("j10", "w2-impostor", 5000)),
      );
      expect(r._tag).toBe("Left");
      await Effect.runPromise(q.close());
    });
  });
}
