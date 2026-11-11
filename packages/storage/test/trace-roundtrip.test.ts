/** Every event kind survives storage: append, list, read back as the same typed event (trace format v1). */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  KNOWN_EVENT_KINDS,
  parseTraceJsonl,
  readEvent,
  summarizeTrace,
  traceToJsonl,
  type HarnessEvent,
} from "@droveragent/core";

import { createLibsqlStorage, createMemoryStorage } from "../src/index.ts";
import type { StorageAdapter } from "../src/index.ts";
import { SAMPLES } from "../../core/test/trace-samples.ts";

const impls: Array<[string, () => Promise<StorageAdapter>]> = [
  ["memory", async () => createMemoryStorage()],
  ["libsql in-memory", async () => createLibsqlStorage({ url: ":memory:" })],
];

for (const [name, factory] of impls) {
  describe(`trace round trip (${name})`, () => {
    test("every known kind, in order, reads back identical", async () => {
      const s = await factory();
      await Effect.runPromise(
        s.createRun({
          id: "run_1",
          agentId: "a",
          specHash: "h",
          status: "running",
          input: {},
          startedAt: 1,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
        }),
      );
      let seq = 0;
      for (const kind of KNOWN_EVENT_KINDS) {
        const e = SAMPLES[kind];
        await Effect.runPromise(
          s.appendEvent({ runId: "run_1", seq: seq++, ts: e.ts, kind: e.kind, payload: e }),
        );
      }
      const rows = await Effect.runPromise(s.listEvents("run_1"));
      expect(rows.map((r) => r.kind)).toEqual([...KNOWN_EVENT_KINDS]);
      for (const r of rows) expect(readEvent(r.payload)).toEqual(SAMPLES[r.kind]);

      // And the stored run exports to a trace file and parses back to the same events.
      const events = rows.map((r) => readEvent(r.payload));
      const back = parseTraceJsonl(
        traceToJsonl({ header: { traceVersion: 1, runId: "run_1" }, events }),
      );
      expect(back.warnings).toEqual([]);
      expect(back.events).toEqual(events);
      expect(summarizeTrace(back.events).unknownEvents).toBe(0);
      await Effect.runPromise(s.close());
    });

    test("a kind this version does not know is stored, listed and read as unknown, never dropped", async () => {
      const s = await factory();
      await Effect.runPromise(
        s.createRun({
          id: "run_2",
          agentId: "a",
          specHash: "h",
          status: "running",
          input: {},
          startedAt: 1,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
        }),
      );
      const future = {
        kind: "some_future_kind",
        runId: "run_2",
        ts: 5,
        from: "a",
        to: "b",
        failureClass: "credits_exhausted",
        status: 402,
      } as unknown as HarnessEvent;
      await Effect.runPromise(
        s.appendEvent({ runId: "run_2", seq: 0, ts: 5, kind: future.kind, payload: future }),
      );
      const [row] = await Effect.runPromise(s.listEvents("run_2"));
      expect(readEvent(row!.payload)).toEqual({
        unknown: true,
        kind: "some_future_kind",
        reason: "unknown_kind",
        raw: future,
      });
      await Effect.runPromise(s.close());
    });
  });
}
