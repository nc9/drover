import { StorageError } from "@droveragent/core";
import { Effect } from "effect";
import { createClient, type Client, type Config } from "@libsql/client";

import type {
  CheckpointRow,
  EventRow,
  RunRow,
  StorageAdapter,
} from "./adapter.ts";
import { MIGRATIONS } from "./migrations.ts";

export interface LibsqlStorageOptions {
  /** libsql URL: "file:/path/to.db", "libsql://...", or ":memory:". */
  url: string;
  /** Bearer token for Turso/remote. */
  authToken?: string;
}

/**
 * libsql-backed `StorageAdapter`. Runs schema migrations idempotently
 * on first call to any read/write method (driven by a one-shot Promise).
 * Works against local file dbs, Turso, in-memory, or Cloudflare-D1-via-libsql.
 */
export async function createLibsqlStorage(opts: LibsqlStorageOptions): Promise<StorageAdapter> {
  const config: Config = opts.authToken
    ? { url: opts.url, authToken: opts.authToken }
    : { url: opts.url };
  const client = createClient(config);

  await runMigrations(client);

  const wrap = <A>(
    op: string,
    runId: string,
    fn: () => Promise<A>,
  ): Effect.Effect<A, StorageError, never> =>
    Effect.tryPromise({
      try: fn,
      catch: (err): StorageError =>
        new StorageError({ runId, op, message: (err as Error).message }),
    });

  return {
    id: "libsql",
    createRun: (row) =>
      wrap("createRun", row.id, async () => {
        await client.execute({
          sql: `INSERT INTO runs (id, parent_run_id, agent_id, spec_hash, status, input, started_at, tokens_in, tokens_out, cost_usd, meta)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
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
          ],
        });
      }),

    updateRun: (id, patch) =>
      wrap("updateRun", id, async () => {
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
        args.push(id);
        await client.execute({
          sql: `UPDATE runs SET ${fields.join(", ")} WHERE id = ?`,
          args,
        });
      }),

    appendEvent: (event) =>
      wrap("appendEvent", event.runId, async () => {
        await client.execute({
          sql: `INSERT OR IGNORE INTO run_events (run_id, seq, ts, kind, payload)
                VALUES (?, ?, ?, ?, ?)`,
          args: [event.runId, event.seq, event.ts, event.kind, JSON.stringify(event.payload)],
        });
      }),

    saveCheckpoint: (cp) =>
      wrap("saveCheckpoint", cp.runId, async () => {
        await client.execute({
          sql: `INSERT OR REPLACE INTO run_checkpoints (run_id, seq, messages, usage, tool_calls, retries_used, ts)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            cp.runId,
            cp.seq,
            JSON.stringify(cp.messages),
            JSON.stringify(cp.usage),
            JSON.stringify(cp.toolCalls),
            cp.retriesUsed,
            cp.ts,
          ],
        });
      }),

    loadRun: (id) =>
      wrap("loadRun", id, async () => {
        const r = await client.execute({
          sql: `SELECT * FROM runs WHERE id = ?`,
          args: [id],
        });
        const row = r.rows[0];
        return row ? rowToRun(row) : null;
      }),

    loadLatestCheckpoint: (runId) =>
      wrap("loadLatestCheckpoint", runId, async () => {
        const r = await client.execute({
          sql: `SELECT * FROM run_checkpoints WHERE run_id = ? ORDER BY seq DESC LIMIT 1`,
          args: [runId],
        });
        const row = r.rows[0];
        return row ? rowToCheckpoint(row) : null;
      }),

    listEvents: (runId) =>
      wrap("listEvents", runId, async () => {
        const r = await client.execute({
          sql: `SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC`,
          args: [runId],
        });
        return r.rows.map(rowToEvent);
      }),

    listRuns: (filter) =>
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
        const limit = filter?.limit ?? 200;
        const offset = filter?.offset ?? 0;
        args.push(limit, offset);
        const r = await client.execute({
          sql: `SELECT * FROM runs ${whereSql} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
          args,
        });
        return r.rows.map(rowToRun);
      }),

    createPendingConfirmation: (row) =>
      wrap("createPendingConfirmation", row.runId, async () => {
        await client.execute({
          sql: `INSERT INTO pending_confirmations (run_id, tool_use_id, tool_name, input, reason, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            row.runId,
            row.toolUseId,
            row.toolName,
            JSON.stringify(row.input),
            row.reason,
            row.createdAt,
          ],
        });
      }),

    resolvePendingConfirmation: (runId, toolUseId, result, resolvedAt) =>
      wrap("resolvePendingConfirmation", runId, async () => {
        await client.execute({
          sql: `UPDATE pending_confirmations SET resolved_at = ?, result = ?
                WHERE run_id = ? AND tool_use_id = ?`,
          args: [resolvedAt, JSON.stringify(result), runId, toolUseId],
        });
      }),

    close: () =>
      Effect.sync(() => {
        client.close();
      }),
  };
}

async function runMigrations(client: Client): Promise<void> {
  // Bootstrap table required so we can record applied migrations.
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS drover_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set<string>();
  const r = await client.execute("SELECT name FROM drover_migrations");
  for (const row of r.rows) applied.add(String(row.name));

  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    // libsql client doesn't support multi-statement parametrised queries —
    // executeMultiple takes raw SQL and runs statements sequentially.
    await client.executeMultiple(m.sql);
    await client.execute({
      sql: "INSERT INTO drover_migrations (name, applied_at) VALUES (?, ?)",
      args: [m.name, Date.now()],
    });
  }
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

