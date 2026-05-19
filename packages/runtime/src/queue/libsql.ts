import { Effect } from "effect";
import { createClient, type Client, type Config, type Row } from "@libsql/client";
import type { RunStatus } from "@drover/core";

import {
  type ClaimedJob,
  type EnqueueInput,
  type QueueAdapter,
  QueueError,
  type QueueJob,
  type QueueListFilter,
} from "./adapter.ts";

export interface LibsqlQueueOptions {
  /** libsql URL: ":memory:", "file:/...", "libsql://..." */
  url: string;
  authToken?: string;
  /** Override the migration table name when colocating with other schemas. */
  migrationsTable?: string;
}

const QUEUE_MIGRATIONS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: "0001_queue_jobs",
    sql: `
      CREATE TABLE IF NOT EXISTS queue_jobs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        input TEXT NOT NULL,
        meta TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        scheduled_for INTEGER,
        status TEXT NOT NULL,
        lease_worker TEXT,
        lease_expires_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        run_id TEXT,
        result_status TEXT,
        result_error TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS queue_jobs_ready_idx
        ON queue_jobs(status, scheduled_for, priority DESC, created_at);
      CREATE INDEX IF NOT EXISTS queue_jobs_lease_idx
        ON queue_jobs(lease_expires_at) WHERE status = 'leased';
    `,
  },
];

/**
 * libsql-backed durable queue. Atomic `claim` via `UPDATE ... RETURNING`
 * with a subselect — no app-side locking required, safe across multiple
 * worker processes pointed at the same DB file.
 */
export async function createLibsqlQueue(opts: LibsqlQueueOptions): Promise<QueueAdapter> {
  const config: Config = opts.authToken
    ? { url: opts.url, authToken: opts.authToken }
    : { url: opts.url };
  const client = createClient(config);
  const migTable = opts.migrationsTable ?? "drover_runtime_migrations";

  await runQueueMigrations(client, migTable);

  const wrap = <A>(
    op: string,
    fn: () => Promise<A>,
  ): Effect.Effect<A, QueueError, never> =>
    Effect.tryPromise({
      try: fn,
      catch: (err): QueueError =>
        new QueueError({ op, message: (err as Error).message }),
    });

  return {
    id: "libsql",
    enqueue: (input: EnqueueInput) =>
      wrap("enqueue", async () => {
        const row: QueueJob = {
          id: input.id,
          agentId: input.agentId,
          input: input.input,
          ...(input.meta ? { meta: input.meta } : {}),
          priority: input.priority ?? 0,
          scheduledFor: input.scheduledFor ?? null,
          status: "queued",
          leaseWorker: null,
          leaseExpiresAt: null,
          attempts: 0,
          maxAttempts: input.maxAttempts ?? 1,
          createdAt: Date.now(),
          runId: null,
          resultStatus: null,
          resultError: null,
        };
        await client.execute({
          sql: `INSERT INTO queue_jobs
                (id, agent_id, input, meta, priority, scheduled_for, status,
                 attempts, max_attempts, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
          args: [
            row.id,
            row.agentId,
            JSON.stringify(row.input),
            row.meta ? JSON.stringify(row.meta) : null,
            row.priority,
            row.scheduledFor,
            row.maxAttempts,
            row.createdAt,
          ],
        });
        return row;
      }),

    // Atomic claim: select the best eligible job and flip its status to
    // 'leased' in one statement. RETURNING gives us back the row so we
    // skip a follow-up SELECT. Concurrent workers race for the lock; the
    // unsuccessful ones see zero rows back.
    claim: (workerId, leaseDurationMs) =>
      wrap("claim", async (): Promise<ClaimedJob | null> => {
        const now = Date.now();
        const leaseExpiresAt = now + leaseDurationMs;
        const result = await client.execute({
          sql: `UPDATE queue_jobs
                  SET status = 'leased',
                      lease_worker = ?,
                      lease_expires_at = ?
                  WHERE id = (
                    SELECT id FROM queue_jobs
                      WHERE status = 'queued'
                        AND (scheduled_for IS NULL OR scheduled_for <= ?)
                      ORDER BY priority DESC, created_at ASC
                      LIMIT 1
                  )
                  RETURNING *`,
          args: [workerId, leaseExpiresAt, now],
        });
        const row = result.rows[0];
        if (!row) return null;
        return { job: rowToJob(row), leaseExpiresAt };
      }),

    heartbeat: (jobId, workerId, leaseDurationMs) =>
      wrap("heartbeat", async () => {
        const newExpiry = Date.now() + leaseDurationMs;
        const r = await client.execute({
          sql: `UPDATE queue_jobs
                  SET lease_expires_at = ?
                  WHERE id = ? AND lease_worker = ? AND status = 'leased'`,
          args: [newExpiry, jobId, workerId],
        });
        if (r.rowsAffected === 0) {
          throw new Error(`lease no longer held by ${workerId}`);
        }
      }),

    complete: (jobId, workerId, runId, status) =>
      wrap("complete", async (): Promise<boolean> => {
        // Lease-guarded: only complete when this worker still holds it.
        const r = await client.execute({
          sql: `UPDATE queue_jobs
                  SET status = 'done',
                      run_id = ?,
                      result_status = ?,
                      lease_worker = NULL,
                      lease_expires_at = NULL
                  WHERE id = ? AND status = 'leased' AND lease_worker = ?`,
          args: [runId, status, jobId, workerId],
        });
        return r.rowsAffected > 0;
      }),

    fail: (jobId, workerId, error, retry) =>
      wrap("fail", async (): Promise<boolean> => {
        // Read attempts/maxAttempts under the lease guard so a stale
        // worker can't bump the counter.
        const r = await client.execute({
          sql: `SELECT attempts, max_attempts FROM queue_jobs
                  WHERE id = ? AND status = 'leased' AND lease_worker = ?`,
          args: [jobId, workerId],
        });
        const row = r.rows[0];
        if (!row) return false; // lost lease — drop result
        const attempts = Number(row.attempts) + 1;
        const maxAttempts = Number(row.max_attempts);
        const nextStatus =
          retry && attempts < maxAttempts ? "queued" : "failed";
        const u = await client.execute({
          sql: `UPDATE queue_jobs
                  SET status = ?,
                      attempts = ?,
                      lease_worker = NULL,
                      lease_expires_at = NULL,
                      result_error = ?
                  WHERE id = ? AND status = 'leased' AND lease_worker = ?`,
          args: [nextStatus, attempts, JSON.stringify(error), jobId, workerId],
        });
        return u.rowsAffected > 0;
      }),

    cancel: (jobId) =>
      wrap("cancel", async () => {
        await client.execute({
          sql: `UPDATE queue_jobs SET cancel_requested = 1 WHERE id = ?`,
          args: [jobId],
        });
        // Immediately terminal if still queued.
        await client.execute({
          sql: `UPDATE queue_jobs
                  SET status = 'cancelled',
                      lease_worker = NULL,
                      lease_expires_at = NULL
                  WHERE id = ? AND status = 'queued'`,
          args: [jobId],
        });
      }),

    cancelRequested: (jobId) =>
      wrap("cancelRequested", async () => {
        const r = await client.execute({
          sql: `SELECT cancel_requested FROM queue_jobs WHERE id = ?`,
          args: [jobId],
        });
        const v = r.rows[0]?.cancel_requested;
        return Number(v ?? 0) !== 0;
      }),

    reclaimStale: (now) =>
      wrap("reclaimStale", async (): Promise<number> => {
        // Two-step recovery. First pass: any leased job whose next
        // attempt would exceed maxAttempts moves to terminal `failed`
        // with a LeaseExpired error. Second pass: the remainder go
        // back to `queued` with attempts incremented.
        const exhausted = await client.execute({
          sql: `UPDATE queue_jobs
                  SET status = 'failed',
                      lease_worker = NULL,
                      lease_expires_at = NULL,
                      attempts = attempts + 1,
                      result_error = ?
                  WHERE status = 'leased'
                    AND lease_expires_at < ?
                    AND attempts + 1 >= max_attempts`,
          args: [
            JSON.stringify({
              tag: "LeaseExpired",
              message: "lease expired and maxAttempts reached",
            }),
            now,
          ],
        });
        const requeued = await client.execute({
          sql: `UPDATE queue_jobs
                  SET status = 'queued',
                      lease_worker = NULL,
                      lease_expires_at = NULL,
                      attempts = attempts + 1
                  WHERE status = 'leased' AND lease_expires_at < ?`,
          args: [now],
        });
        return exhausted.rowsAffected + requeued.rowsAffected;
      }),

    get: (jobId) =>
      wrap("get", async () => {
        const r = await client.execute({
          sql: `SELECT * FROM queue_jobs WHERE id = ?`,
          args: [jobId],
        });
        const row = r.rows[0];
        return row ? rowToJob(row) : null;
      }),

    list: (filter?: QueueListFilter) =>
      wrap("list", async (): Promise<ReadonlyArray<QueueJob>> => {
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
        const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
        const limit = filter?.limit ?? 200;
        const offset = filter?.offset ?? 0;
        args.push(limit, offset);
        const r = await client.execute({
          sql: `SELECT * FROM queue_jobs ${whereSql}
                  ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          args,
        });
        return r.rows.map(rowToJob);
      }),

    close: () =>
      Effect.sync(() => {
        client.close();
      }),
  };
}

async function runQueueMigrations(client: Client, table: string): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS ${table} (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set<string>();
  const r = await client.execute(`SELECT name FROM ${table}`);
  for (const row of r.rows) applied.add(String(row.name));

  for (const m of QUEUE_MIGRATIONS) {
    if (applied.has(m.name)) continue;
    await client.executeMultiple(m.sql);
    await client.execute({
      sql: `INSERT INTO ${table} (name, applied_at) VALUES (?, ?)`,
      args: [m.name, Date.now()],
    });
  }
}

function rowToJob(row: Row): QueueJob {
  const meta = row.meta != null ? safeParse(String(row.meta)) : null;
  const resultError =
    row.result_error != null
      ? (safeParse(String(row.result_error)) as { tag: string; message: string } | null)
      : null;
  const out: QueueJob = {
    id: String(row.id),
    agentId: String(row.agent_id),
    input: safeParse(String(row.input)),
    priority: toNumber(row.priority),
    scheduledFor: row.scheduled_for == null ? null : toNumber(row.scheduled_for),
    status: String(row.status) as QueueJob["status"],
    leaseWorker: row.lease_worker == null ? null : String(row.lease_worker),
    leaseExpiresAt:
      row.lease_expires_at == null ? null : toNumber(row.lease_expires_at),
    attempts: toNumber(row.attempts),
    maxAttempts: toNumber(row.max_attempts),
    createdAt: toNumber(row.created_at),
    runId: row.run_id == null ? null : String(row.run_id),
    resultStatus:
      row.result_status == null ? null : (String(row.result_status) as RunStatus),
    resultError,
  };
  if (meta && typeof meta === "object") out.meta = meta as Record<string, unknown>;
  return out;
}

function safeParse(v: string): unknown {
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
