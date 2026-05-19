import { describe, test, expect } from "bun:test";
import { Effect } from "effect";

import { createMemoryStorage, createLibsqlStorage } from "../src/index.ts";
import type { StorageAdapter } from "../src/index.ts";

const impls: Array<[string, () => Promise<StorageAdapter>]> = [
  ["memory", async () => createMemoryStorage()],
  ["libsql in-memory", async () => createLibsqlStorage({ url: ":memory:" })],
];

for (const [name, factory] of impls) {
  describe(`StorageAdapter (${name})`, () => {
    test("createRun + loadRun round-trip", async () => {
      const s = await factory();
      const now = Date.now();
      await Effect.runPromise(
        s.createRun({
          id: "r1",
          agentId: "a",
          specHash: "h",
          status: "running",
          input: { x: 1 },
          startedAt: now,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
        }),
      );
      const loaded = await Effect.runPromise(s.loadRun("r1"));
      expect(loaded?.id).toBe("r1");
      expect(loaded?.status).toBe("running");
      expect(loaded?.input).toEqual({ x: 1 });
      await Effect.runPromise(s.close());
    });

    test("appendEvent + listEvents preserves order", async () => {
      const s = await factory();
      const now = Date.now();
      await Effect.runPromise(
        s.createRun({
          id: "r2",
          agentId: "a",
          specHash: "h",
          status: "running",
          input: {},
          startedAt: now,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
        }),
      );
      for (let i = 0; i < 3; i++) {
        await Effect.runPromise(
          s.appendEvent({
            runId: "r2",
            seq: i,
            ts: now + i,
            kind: "turn_start",
            payload: { kind: "turn_start", runId: "r2", turn: i, ts: now + i },
          }),
        );
      }
      const events = await Effect.runPromise(s.listEvents("r2"));
      expect(events.length).toBe(3);
      expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
      await Effect.runPromise(s.close());
    });

    test("saveCheckpoint + loadLatestCheckpoint returns last by seq", async () => {
      const s = await factory();
      const now = Date.now();
      await Effect.runPromise(
        s.createRun({
          id: "r3",
          agentId: "a",
          specHash: "h",
          status: "running",
          input: {},
          startedAt: now,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
        }),
      );
      for (let i = 1; i <= 3; i++) {
        await Effect.runPromise(
          s.saveCheckpoint({
            runId: "r3",
            seq: i,
            messages: [{ role: "user", content: `msg-${i}` }],
            usage: { inputTokens: i * 10, outputTokens: i * 5 },
            toolCalls: [],
            retriesUsed: 0,
            ts: now + i,
          }),
        );
      }
      const cp = await Effect.runPromise(s.loadLatestCheckpoint("r3"));
      expect(cp?.seq).toBe(3);
      expect(cp?.usage.inputTokens).toBe(30);
      await Effect.runPromise(s.close());
    });

    test("loadLatestCheckpoint returns null when none saved", async () => {
      const s = await factory();
      const cp = await Effect.runPromise(s.loadLatestCheckpoint("nonexistent"));
      expect(cp).toBeNull();
      await Effect.runPromise(s.close());
    });

    test("updateRun applies patch", async () => {
      const s = await factory();
      const now = Date.now();
      await Effect.runPromise(
        s.createRun({
          id: "r4",
          agentId: "a",
          specHash: "h",
          status: "running",
          input: {},
          startedAt: now,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
        }),
      );
      await Effect.runPromise(
        s.updateRun("r4", {
          status: "success",
          endedAt: now + 1000,
          tokensIn: 100,
          tokensOut: 50,
          costUsd: 0.001,
          output: { result: "ok" },
        }),
      );
      const loaded = await Effect.runPromise(s.loadRun("r4"));
      expect(loaded?.status).toBe("success");
      expect(loaded?.tokensIn).toBe(100);
      expect(loaded?.output).toEqual({ result: "ok" });
      await Effect.runPromise(s.close());
    });
  });
}
