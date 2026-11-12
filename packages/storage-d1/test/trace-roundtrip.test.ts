/**
 * Every event kind survives D1 storage: append, list, read back as the same typed event (trace
 * format v1). Mirrors storage/test/trace-roundtrip.test.ts for the memory and libsql adapters.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import {
  KNOWN_EVENT_KINDS,
  parseTraceJsonl,
  readEvent,
  summarizeTrace,
  traceToJsonl,
  type HarnessEvent,
} from "@droveragent/core";

import { createD1Storage } from "../src/index.ts";
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from "../src/index.ts";
import { SAMPLES } from "../../core/test/trace-samples.ts";

type Bindable = string | number | bigint | boolean | null | Uint8Array;

/** The D1 surface the adapter uses, over `bun:sqlite` (as in d1.test.ts). */
function makeD1(): D1DatabaseLike {
  const sqlite = new Database(":memory:");
  const statement = (sql: string, params: readonly unknown[]): D1PreparedStatementLike => ({
    bind: (...values: unknown[]): D1PreparedStatementLike => statement(sql, values),
    all: async <T = Record<string, unknown>>(): Promise<D1ResultLike<T>> => ({
      results: sqlite.prepare(sql).all(...(params as Bindable[])) as T[],
    }),
    run: async (): Promise<unknown> => sqlite.prepare(sql).run(...(params as Bindable[])),
  });
  return {
    prepare: (sql: string): D1PreparedStatementLike => statement(sql, []),
    batch: async (statements): Promise<unknown[]> => {
      sqlite.exec("BEGIN");
      try {
        const out: unknown[] = [];
        for (const s of statements) out.push(await s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

const run = (id: string) => ({
  id,
  agentId: "a",
  specHash: "h",
  status: "running" as const,
  input: {},
  startedAt: 1,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
});

describe("trace round trip (d1)", () => {
  test("every known kind, in order, reads back identical", async () => {
    const s = createD1Storage({ db: makeD1() });
    await Effect.runPromise(s.createRun(run("run_1")));
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
    const s = createD1Storage({ db: makeD1() });
    await Effect.runPromise(s.createRun(run("run_2")));
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
