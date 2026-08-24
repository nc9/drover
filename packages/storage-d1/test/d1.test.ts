import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";

import { createD1Storage, migrateD1, splitStatements } from "../src/index.ts";
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from "../src/index.ts";

/**
 * Minimal D1 shim over `bun:sqlite` — the same surface the adapter consumes
 * (`prepare` → `bind`/`all`/`run`, plus `batch`). Cheaper and more portable
 * than booting miniflare's D1 for what is, at bottom, SQLite either way.
 */
interface Shim {
  db: D1DatabaseLike;
  sqlite: Database;
  /** Every SQL string handed to `prepare`, in order. */
  prepared: string[];
  batches: number;
}

type Bindable = string | number | bigint | boolean | null | Uint8Array;

function makeD1(): Shim {
  const sqlite = new Database(":memory:");
  const prepared: string[] = [];
  const state = { batches: 0 };

  const statement = (sql: string, params: readonly unknown[]): D1PreparedStatementLike => ({
    bind: (...values: unknown[]): D1PreparedStatementLike => statement(sql, values),
    all: async <T = Record<string, unknown>>(): Promise<D1ResultLike<T>> => ({
      results: sqlite.prepare(sql).all(...(params as Bindable[])) as T[],
    }),
    run: async (): Promise<unknown> => sqlite.prepare(sql).run(...(params as Bindable[])),
  });

  const db: D1DatabaseLike = {
    prepare: (sql: string): D1PreparedStatementLike => {
      prepared.push(sql);
      return statement(sql, []);
    },
    batch: async (statements): Promise<unknown[]> => {
      state.batches++;
      // D1 wraps a batch in an implicit transaction.
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

  return {
    db,
    sqlite,
    prepared,
    get batches(): number {
      return state.batches;
    },
  };
}

const baseRun = (id: string, now: number) => ({
  id,
  agentId: "a",
  specHash: "h",
  status: "running" as const,
  input: {},
  startedAt: now,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
});

describe("splitStatements", () => {
  test("splits on top-level semicolons and drops blanks", () => {
    expect(splitStatements("SELECT 1; SELECT 2;;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  test("ignores semicolons inside string literals", () => {
    expect(splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1")).toEqual([
      "INSERT INTO t VALUES ('a;b')",
      "SELECT 1",
    ]);
  });

  test("ignores semicolons inside line and block comments", () => {
    expect(splitStatements("SELECT 1 -- a; b\n; /* c; d */ SELECT 2")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  test("handles doubled quotes as escapes, not terminators", () => {
    expect(splitStatements("SELECT 'it''s; fine'; SELECT 2")).toEqual([
      "SELECT 'it''s; fine'",
      "SELECT 2",
    ]);
  });

  test("splits the bundled migration into executable statements", () => {
    const shim = makeD1();
    // Every statement the splitter produces must be individually valid.
    const sql = splitStatements(
      `CREATE TABLE a (id TEXT PRIMARY KEY);
       CREATE INDEX IF NOT EXISTS a_idx ON a(id);`,
    );
    for (const s of sql) shim.sqlite.exec(s);
    expect(sql.length).toBe(2);
  });
});

describe("migrateD1", () => {
  test("creates every drover table", async () => {
    const shim = makeD1();
    await migrateD1(shim.db);
    const names = shim.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const set = new Set(names.map((n) => n.name));
    expect(set.has("runs")).toBe(true);
    expect(set.has("run_events")).toBe(true);
    expect(set.has("run_checkpoints")).toBe(true);
    expect(set.has("pending_confirmations")).toBe(true);
    expect(set.has("drover_migrations")).toBe(true);
  });

  test("is idempotent — second call applies nothing", async () => {
    const shim = makeD1();
    await migrateD1(shim.db);
    const first = shim.batches;
    await migrateD1(shim.db);
    // Only the bootstrap-ledger batch runs the second time.
    expect(shim.batches).toBe(first + 1);
    const applied = shim.sqlite.prepare("SELECT name FROM drover_migrations").all();
    expect(applied.length).toBe(1);
  });
});

describe("createD1Storage", () => {
  test("migrates lazily on first op, once", async () => {
    const shim = makeD1();
    const s = createD1Storage({ db: shim.db });
    expect(shim.batches).toBe(0);
    const now = Date.now();
    await Effect.runPromise(s.createRun(baseRun("r1", now)));
    const afterFirst = shim.batches;
    expect(afterFirst).toBeGreaterThan(0);
    await Effect.runPromise(s.createRun(baseRun("r1b", now)));
    expect(shim.batches).toBe(afterFirst);
  });

  test("concurrent first ops share one migration", async () => {
    const shim = makeD1();
    const s = createD1Storage({ db: shim.db });
    const now = Date.now();
    await Promise.all([
      Effect.runPromise(s.createRun(baseRun("c1", now))),
      Effect.runPromise(s.createRun(baseRun("c2", now))),
      Effect.runPromise(s.createRun(baseRun("c3", now))),
    ]);
    const applied = shim.sqlite.prepare("SELECT name FROM drover_migrations").all();
    expect(applied.length).toBe(1);
    const runs = await Effect.runPromise(s.listRuns());
    expect(runs.length).toBe(3);
  });

  test("autoMigrate: false skips migration entirely", async () => {
    const shim = makeD1();
    await migrateD1(shim.db);
    const before = shim.batches;
    const s = createD1Storage({ db: shim.db, autoMigrate: false });
    await Effect.runPromise(s.createRun(baseRun("nm", Date.now())));
    expect(shim.batches).toBe(before);
  });

  test("createRun + loadRun round-trip", async () => {
    const shim = makeD1();
    const s = createD1Storage({ db: shim.db });
    const now = Date.now();
    await Effect.runPromise(
      s.createRun({ ...baseRun("r1", now), input: { x: 1 }, meta: { orgId: "org_1" } }),
    );
    const loaded = await Effect.runPromise(s.loadRun("r1"));
    expect(loaded?.id).toBe("r1");
    expect(loaded?.status).toBe("running");
    expect(loaded?.input).toEqual({ x: 1 });
    expect(loaded?.meta).toEqual({ orgId: "org_1" });
    expect(loaded?.parentRunId).toBeUndefined();
  });

  test("loadRun returns null for a missing id", async () => {
    const shim = makeD1();
    const s = createD1Storage({ db: shim.db });
    expect(await Effect.runPromise(s.loadRun("nope"))).toBeNull();
  });

  test("appendEvent + listEvents preserves seq order and is idempotent", async () => {
    const shim = makeD1();
    const s = createD1Storage({ db: shim.db });
    const now = Date.now();
    await Effect.runPromise(s.createRun(baseRun("r2", now)));
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
    // Replaying the same seq must not duplicate (INSERT OR IGNORE).
    await Effect.runPromise(
      s.appendEvent({
        runId: "r2",
        seq: 0,
        ts: now,
        kind: "turn_start",
        payload: { kind: "turn_start", runId: "r2", turn: 0, ts: now },
      }),
    );
    const events = await Effect.runPromise(s.listEvents("r2"));
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events[0]?.payload.kind).toBe("turn_start");
  });

  test("saveCheckpoint + loadLatestCheckpoint returns last by seq", async () => {
    const shim = makeD1();
    const s = createD1Storage({ db: shim.db });
    const now = Date.now();
    await Effect.runPromise(s.createRun(baseRun("r3", now)));
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
    expect(cp?.messages).toEqual([{ role: "user", content: "msg-3" }]);
  });

  test("loadLatestCheckpoint returns null when none saved", async () => {
    const shim = makeD1();
    const s = createD1Storage({ db: shim.db });
    expect(await Effect.runPromise(s.loadLatestCheckpoint("nope"))).toBeNull();
  });

  test("updateRun applies a partial patch", async () => {
    const shim = makeD1();
    const s = createD1Storage({ db: shim.db });
    const now = Date.now();
    await Effect.runPromise(s.createRun(baseRun("r4", now)));
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
    expect(loaded?.costUsd).toBeCloseTo(0.001);
    expect(loaded?.output).toEqual({ result: "ok" });
  });

  test("updateRun with an empty patch is a no-op", async () => {
    const shim = makeD1();
    const s = createD1Storage({ db: shim.db });
    await Effect.runPromise(s.createRun(baseRun("r5", Date.now())));
    await Effect.runPromise(s.updateRun("r5", {}));
    expect((await Effect.runPromise(s.loadRun("r5")))?.status).toBe("running");
  });

  test("listRuns filters by status, agent and parent", async () => {
    const shim = makeD1();
    const s = createD1Storage({ db: shim.db });
    const now = Date.now();
    await Effect.runPromise(s.createRun({ ...baseRun("p1", now), agentId: "alpha" }));
    await Effect.runPromise(
      s.createRun({ ...baseRun("c1", now + 1), agentId: "beta", parentRunId: "p1" }),
    );
    await Effect.runPromise(s.updateRun("c1", { status: "success" }));

    const roots = await Effect.runPromise(s.listRuns({ parentRunId: null }));
    expect(roots.map((r) => r.id)).toEqual(["p1"]);

    const children = await Effect.runPromise(s.listRuns({ parentRunId: "p1" }));
    expect(children.map((r) => r.id)).toEqual(["c1"]);
    expect(children[0]?.parentRunId).toBe("p1");

    const done = await Effect.runPromise(s.listRuns({ status: ["success"] }));
    expect(done.map((r) => r.id)).toEqual(["c1"]);

    const byAgent = await Effect.runPromise(s.listRuns({ agentId: "alpha" }));
    expect(byAgent.map((r) => r.id)).toEqual(["p1"]);

    const paged = await Effect.runPromise(s.listRuns({ limit: 1, offset: 1 }));
    expect(paged.length).toBe(1);
  });

  test("pending confirmations create + resolve", async () => {
    const shim = makeD1();
    const s = createD1Storage({ db: shim.db });
    const now = Date.now();
    await Effect.runPromise(s.createRun(baseRun("r6", now)));
    await Effect.runPromise(
      s.createPendingConfirmation({
        runId: "r6",
        toolUseId: "tu_1",
        toolName: "bash",
        input: { cmd: "rm -rf /" },
        reason: "destructive",
        createdAt: now,
      }),
    );
    let row = shim.sqlite
      .prepare("SELECT * FROM pending_confirmations WHERE run_id = 'r6'")
      .get() as Record<string, unknown>;
    expect(row.resolved_at).toBeNull();

    await Effect.runPromise(s.resolvePendingConfirmation("r6", "tu_1", { ok: true }, now + 5));
    row = shim.sqlite
      .prepare("SELECT * FROM pending_confirmations WHERE run_id = 'r6'")
      .get() as Record<string, unknown>;
    expect(row.resolved_at).toBe(now + 5);
    expect(JSON.parse(String(row.result))).toEqual({ ok: true });
  });

  test("surfaces DB failures as StorageError, tagged with the op", async () => {
    const shim = makeD1();
    const s = createD1Storage({ db: shim.db });
    const now = Date.now();
    await Effect.runPromise(s.createRun(baseRun("dup", now)));
    const either = await Effect.runPromise(Effect.either(s.createRun(baseRun("dup", now))));
    expect(either._tag).toBe("Left");
    if (either._tag === "Left") {
      expect(either.left._tag).toBe("StorageError");
      expect(either.left.op).toBe("createRun");
      expect(either.left.runId).toBe("dup");
    }
  });

  test("a failed migration is retried on the next op", async () => {
    const shim = makeD1();
    let fail = true;
    const guarded: D1DatabaseLike = {
      prepare: shim.db.prepare.bind(shim.db),
      batch: async (statements): Promise<unknown[]> => {
        if (fail) {
          fail = false;
          throw new Error("D1_ERROR: transient");
        }
        return shim.db.batch(statements);
      },
    };
    const s = createD1Storage({ db: guarded });
    const now = Date.now();
    const first = await Effect.runPromise(Effect.either(s.createRun(baseRun("m1", now))));
    expect(first._tag).toBe("Left");
    await Effect.runPromise(s.createRun(baseRun("m2", now)));
    expect((await Effect.runPromise(s.loadRun("m2")))?.id).toBe("m2");
  });

  test("close is a no-op the runtime owns", async () => {
    const shim = makeD1();
    const s = createD1Storage({ db: shim.db });
    await Effect.runPromise(s.close());
    expect(s.id).toBe("d1");
  });

  test("id is overridable for telemetry", () => {
    const shim = makeD1();
    expect(createD1Storage({ db: shim.db, id: "d1-primary" }).id).toBe("d1-primary");
  });
});
