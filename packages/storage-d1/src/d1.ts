import { StorageError } from "@droveragent/core";
import type {
  CheckpointRow,
  EventRow,
  PendingConfirmationRow,
  RunListFilter,
  RunRow,
  StorageAdapter,
} from "@droveragent/storage";
// Pure data — no `@libsql/client` in the import graph, so this module stays
// bundleable for `workerd`. (The package root re-exports the libsql adapter;
// importing it here would drag a node-only driver into the Worker bundle.)
import { MIGRATIONS } from "@droveragent/storage/migrations";
import { Effect } from "effect";

/**
 * Structural slice of Cloudflare's `D1Result`. Only `results` is consumed —
 * `meta`/`success` are ignored, so a real `D1Result` is assignable.
 */
export interface D1ResultLike<T = Record<string, unknown>> {
  results: T[];
}

/**
 * Structural slice of `D1PreparedStatement`. Declared with method syntax so
 * the real (narrower) SDK types remain assignable under bivariance.
 */
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  run(): Promise<unknown>;
}

/**
 * Structural slice of the `D1Database` binding — the only thing this adapter
 * needs from `env.DB`. Tests implement it directly (see `test/d1.test.ts`,
 * which drives it with `bun:sqlite`) instead of booting workerd.
 *
 * `exec` is deliberately absent: D1's `exec` requires every statement on its
 * own single line, which the shared migration SQL does not satisfy. All DDL
 * goes through `batch` (one implicit transaction) instead.
 */
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

export interface D1StorageOptions {
  /** The D1 binding, e.g. `env.DB`. */
  db: D1DatabaseLike;
  /**
   * Apply schema migrations lazily, before the first storage op. Default
   * true. Set false when migrations are applied out-of-band (`wrangler d1
   * migrations apply`) — saves one round-trip per isolate.
   */
  autoMigrate?: boolean;
  /** Telemetry identifier. Default `"d1"`. */
  id?: string;
}

/**
 * Cloudflare D1 `StorageAdapter` — the same event-sourced schema as the
 * libsql adapter (`runs` / `run_events` / `run_checkpoints` /
 * `pending_confirmations`), driven through the Workers D1 binding.
 *
 * Differences from `createLibsqlStorage`, all forced by the runtime:
 *
 * - **Synchronous factory.** A Worker builds the adapter inside the request
 *   handler where the binding first exists; there is no top-level `await` to
 *   run migrations in. Migrations are instead lazy and memoised per isolate
 *   (a failed attempt resets so the next op retries).
 * - **`batch`, not `executeMultiple`.** D1's `exec` can't take the shared
 *   multi-line migration SQL, so each migration is split into statements and
 *   submitted as one `batch` — which D1 wraps in an implicit transaction, so
 *   a migration is all-or-nothing.
 * - **`close()` is a no-op.** Bindings are owned by the runtime.
 *
 * Concurrent isolates racing the first migration is safe: every statement is
 * `IF NOT EXISTS` / `INSERT OR IGNORE`.
 */
export function createD1Storage(opts: D1StorageOptions): StorageAdapter {
  const { db } = opts;
  const id = opts.id ?? "d1";
  const autoMigrate = opts.autoMigrate ?? true;

  // Lazy, memoised migration. Concurrent first ops share one in-flight run;
  // a failure resets so the next op can retry.
  let migrationP: Promise<void> | null = null;
  const ready = (): Promise<void> => {
    if (!autoMigrate) return Promise.resolve();
    migrationP ??= migrateD1(db).catch((err: unknown) => {
      migrationP = null;
      throw err;
    });
    return migrationP;
  };

  const wrap = <A>(
    op: string,
    runId: string,
    fn: () => Promise<A>,
  ): Effect.Effect<A, StorageError, never> =>
    Effect.tryPromise({
      try: async (): Promise<A> => {
        await ready();
        return await fn();
      },
      catch: (err): StorageError =>
        new StorageError({
          runId,
          op,
          message: err instanceof Error ? err.message : String(err),
        }),
    });

  return {
    id,

    createRun: (row: RunRow) =>
      wrap("createRun", row.id, async () => {
        await db
          .prepare(
            `INSERT INTO runs (id, parent_run_id, agent_id, spec_hash, status, input, started_at, tokens_in, tokens_out, cost_usd, meta)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            row.id,
            row.parentRunId ?? null,
            row.agentId,
            row.specHash,
            row.status,
            JSON.stringify(row.input),
            row.startedAt,
            row.tokensIn,
            row.tokensOut,
            row.costUsd,
            row.meta ? JSON.stringify(row.meta) : null,
          )
          .run();
      }),

    updateRun: (id_, patch) =>
      wrap("updateRun", id_, async () => {
        const fields: string[] = [];
        const args: Array<string | number | null> = [];
        if (patch.status !== undefined) {
          fields.push("status = ?");
          args.push(patch.status);
        }
        if (patch.output !== undefined) {
          fields.push("output = ?");
          args.push(JSON.stringify(patch.output));
        }
        if (patch.error !== undefined) {
          fields.push("error = ?");
          args.push(patch.error ? JSON.stringify(patch.error) : null);
        }
        if (patch.endedAt !== undefined) {
          fields.push("ended_at = ?");
          args.push(patch.endedAt);
        }
        if (patch.tokensIn !== undefined) {
          fields.push("tokens_in = ?");
          args.push(patch.tokensIn);
        }
        if (patch.tokensOut !== undefined) {
          fields.push("tokens_out = ?");
          args.push(patch.tokensOut);
        }
        if (patch.costUsd !== undefined) {
          fields.push("cost_usd = ?");
          args.push(patch.costUsd);
        }
        if (patch.parentRunId !== undefined) {
          fields.push("parent_run_id = ?");
          args.push(patch.parentRunId ?? null);
        }
        if (patch.meta !== undefined) {
          fields.push("meta = ?");
          args.push(patch.meta ? JSON.stringify(patch.meta) : null);
        }
        if (fields.length === 0) return;
        args.push(id_);
        await db
          .prepare(`UPDATE runs SET ${fields.join(", ")} WHERE id = ?`)
          .bind(...args)
          .run();
      }),

    appendEvent: (event: EventRow) =>
      wrap("appendEvent", event.runId, async () => {
        await db
          .prepare(
            `INSERT OR IGNORE INTO run_events (run_id, seq, ts, kind, payload)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(event.runId, event.seq, event.ts, event.kind, JSON.stringify(event.payload))
          .run();
      }),

    saveCheckpoint: (cp: CheckpointRow) =>
      wrap("saveCheckpoint", cp.runId, async () => {
        await db
          .prepare(
            `INSERT OR REPLACE INTO run_checkpoints (run_id, seq, messages, usage, tool_calls, retries_used, ts)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            cp.runId,
            cp.seq,
            JSON.stringify(cp.messages),
            JSON.stringify(cp.usage),
            JSON.stringify(cp.toolCalls),
            cp.retriesUsed,
            cp.ts,
          )
          .run();
      }),

    loadRun: (id_) =>
      wrap("loadRun", id_, async () => {
        const r = await db.prepare(`SELECT * FROM runs WHERE id = ?`).bind(id_).all();
        const row = r.results[0];
        return row ? rowToRun(row) : null;
      }),

    loadLatestCheckpoint: (runId) =>
      wrap("loadLatestCheckpoint", runId, async () => {
        const r = await db
          .prepare(`SELECT * FROM run_checkpoints WHERE run_id = ? ORDER BY seq DESC LIMIT 1`)
          .bind(runId)
          .all();
        const row = r.results[0];
        return row ? rowToCheckpoint(row) : null;
      }),

    listEvents: (runId) =>
      wrap("listEvents", runId, async () => {
        const r = await db
          .prepare(`SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC`)
          .bind(runId)
          .all();
        return r.results.map(rowToEvent);
      }),

    listRuns: (filter?: RunListFilter) =>
      wrap("listRuns", "(query)", async () => {
        const wheres: string[] = [];
        const args: Array<string | number> = [];
        if (filter?.status?.length) {
          wheres.push(`status IN (${filter.status.map(() => "?").join(",")})`);
          for (const s of filter.status) args.push(s);
        }
        if (filter?.agentId) {
          wheres.push("agent_id = ?");
          args.push(filter.agentId);
        }
        if (filter?.parentRunId === null) {
          wheres.push("parent_run_id IS NULL");
        } else if (filter?.parentRunId) {
          wheres.push("parent_run_id = ?");
          args.push(filter.parentRunId);
        }
        if (filter?.startedAfter !== undefined) {
          wheres.push("started_at >= ?");
          args.push(filter.startedAfter);
        }
        const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
        args.push(filter?.limit ?? 200, filter?.offset ?? 0);
        const r = await db
          .prepare(`SELECT * FROM runs ${whereSql} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
          .bind(...args)
          .all();
        return r.results.map(rowToRun);
      }),

    createPendingConfirmation: (row: PendingConfirmationRow) =>
      wrap("createPendingConfirmation", row.runId, async () => {
        await db
          .prepare(
            `INSERT INTO pending_confirmations (run_id, tool_use_id, tool_name, input, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            row.runId,
            row.toolUseId,
            row.toolName,
            JSON.stringify(row.input),
            row.reason,
            row.createdAt,
          )
          .run();
      }),

    resolvePendingConfirmation: (runId, toolUseId, result, resolvedAt) =>
      wrap("resolvePendingConfirmation", runId, async () => {
        await db
          .prepare(
            `UPDATE pending_confirmations SET resolved_at = ?, result = ?
             WHERE run_id = ? AND tool_use_id = ?`,
          )
          .bind(resolvedAt, JSON.stringify(result), runId, toolUseId)
          .run();
      }),

    // Bindings are runtime-owned; there is nothing to dispose.
    close: () => Effect.void,
  };
}

/**
 * Apply the drover schema to a D1 database. Idempotent — already-applied
 * migrations are skipped via the `drover_migrations` ledger. Exposed so a
 * deploy step (or a `wrangler d1 execute` wrapper) can migrate ahead of time
 * and run the adapter with `autoMigrate: false`.
 */
export async function migrateD1(db: D1DatabaseLike): Promise<void> {
  // Bootstrap ledger first — needed before we can record anything.
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS drover_migrations (
         name TEXT PRIMARY KEY,
         applied_at INTEGER NOT NULL
       )`,
    ),
  ]);

  const applied = new Set<string>();
  const r = await db.prepare("SELECT name FROM drover_migrations").all<{ name: string }>();
  for (const row of r.results) applied.add(String(row.name));

  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    const statements = splitStatements(m.sql).map((sql) => db.prepare(sql));
    statements.push(
      db
        .prepare("INSERT OR IGNORE INTO drover_migrations (name, applied_at) VALUES (?, ?)")
        .bind(m.name, Date.now()),
    );
    // One batch == one implicit transaction, so a migration is atomic.
    await db.batch(statements);
  }
}

/**
 * Split a multi-statement SQL script on top-level `;`. Quote- and
 * comment-aware so a semicolon inside a string literal or a `--` comment
 * doesn't cut a statement in half.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i] as string;
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) {
        // Doubled quote is an escaped literal, not a terminator.
        if (next === quote) {
          current += next;
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "-" && next === "-") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed) out.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) out.push(tail);
  return out;
}

// ── row → typed object ─────────────────────────────────────────────────────

function rowToRun(row: Record<string, unknown>): RunRow {
  const out: RunRow = {
    id: String(row.id),
    agentId: String(row.agent_id),
    specHash: String(row.spec_hash),
    status: String(row.status) as RunRow["status"],
    input: parseJson(row.input),
    startedAt: toNumber(row.started_at),
    tokensIn: toNumber(row.tokens_in),
    tokensOut: toNumber(row.tokens_out),
    costUsd: toNumber(row.cost_usd),
  };
  if (row.parent_run_id != null) out.parentRunId = String(row.parent_run_id);
  if (row.output != null) out.output = parseJson(row.output);
  if (row.error != null) {
    const parsed = parseJson(row.error);
    if (parsed && typeof parsed === "object") {
      out.error = parsed as { tag: string; message: string };
    }
  }
  if (row.ended_at != null) out.endedAt = toNumber(row.ended_at);
  if (row.meta != null) {
    const parsed = parseJson(row.meta);
    if (parsed && typeof parsed === "object") {
      out.meta = parsed as Record<string, unknown>;
    }
  }
  return out;
}

function rowToEvent(row: Record<string, unknown>): EventRow {
  return {
    runId: String(row.run_id),
    seq: toNumber(row.seq),
    ts: toNumber(row.ts),
    kind: String(row.kind) as EventRow["kind"],
    payload: parseJson(row.payload) as EventRow["payload"],
  };
}

function rowToCheckpoint(row: Record<string, unknown>): CheckpointRow {
  return {
    runId: String(row.run_id),
    seq: toNumber(row.seq),
    messages: parseJson(row.messages),
    usage: parseJson(row.usage) as CheckpointRow["usage"],
    toolCalls: parseJson(row.tool_calls) as ReadonlyArray<string>,
    retriesUsed: toNumber(row.retries_used),
    ts: toNumber(row.ts),
  };
}

function parseJson(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return Number(v);
  return 0;
}
