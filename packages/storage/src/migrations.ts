/** Bundled SQL migrations for libsql. Numeric prefix = execution order. */
export const MIGRATIONS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: "0001_init",
    sql: `
      CREATE TABLE IF NOT EXISTS drover_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        parent_run_id TEXT,
        agent_id TEXT NOT NULL,
        spec_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_started_at_idx ON runs(started_at DESC);
      CREATE INDEX IF NOT EXISTS runs_parent_idx ON runs(parent_run_id);
      CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);
      CREATE INDEX IF NOT EXISTS runs_agent_idx ON runs(agent_id);

      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS run_events_ts_idx ON run_events(run_id, ts);

      CREATE TABLE IF NOT EXISTS run_checkpoints (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        messages TEXT NOT NULL,
        usage TEXT NOT NULL,
        tool_calls TEXT NOT NULL,
        retries_used INTEGER NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );

      CREATE TABLE IF NOT EXISTS pending_confirmations (
        run_id TEXT NOT NULL,
        tool_use_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        result TEXT,
        PRIMARY KEY (run_id, tool_use_id)
      );
      CREATE INDEX IF NOT EXISTS pending_confirmations_unresolved_idx
        ON pending_confirmations(run_id) WHERE resolved_at IS NULL;
    `,
  },
];
