import { MemoryError } from "@droveragent/core";
import type { Effect } from "effect";

/** Three durable scopes. */
export type MemoryScope = "global" | "agent" | "run";

/**
 * Memory taxonomy borrowed from the auto-memory schema. `user` =
 * facts about the operator; `feedback` = behavioural rules learned
 * from corrections; `project` = state about ongoing work; `reference`
 * = pointers to external systems.
 */
export type MemoryKind = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  /** ULID. Used as the on-disk filename for the markdown adapter. */
  id: string;
  scope: MemoryScope;
  /** Present when `scope` is `agent` or `run`. */
  agentId?: string;
  /** Present when `scope` is `run`. */
  runId?: string;
  kind: MemoryKind;
  /** ≤200 chars; one-line index entry. */
  summary: string;
  /** Markdown body; recommended ≤2000 chars. */
  body: string;
  tags?: ReadonlyArray<string>;
  /** Epoch millis. */
  createdAt: number;
  /** Epoch millis. Refreshed on every `put` with an existing id. */
  updatedAt?: number;
}

/** Caller-supplied draft for `put`. */
export interface MemoryDraft {
  /** Omit to create; pass to update. */
  id?: string;
  scope: MemoryScope;
  agentId?: string;
  runId?: string;
  kind: MemoryKind;
  summary: string;
  body: string;
  tags?: ReadonlyArray<string>;
}

export interface SearchOpts {
  /** BM25 query over summary + body + tags. Omit for unranked list. */
  query?: string;
  /** Defaults: `["global", "agent"]` when no `runId`, all three otherwise. */
  scopes?: ReadonlyArray<MemoryScope>;
  /** Filter agent-scope entries to a specific agent. */
  agentId?: string;
  /** Required when `"run"` ∈ `scopes`. */
  runId?: string;
  kinds?: ReadonlyArray<MemoryKind>;
  /** Entry matches if ANY of its tags overlaps. */
  tags?: ReadonlyArray<string>;
  /** Default 20. */
  limit?: number;
}

export interface MemoryHit extends MemoryEntry {
  /** BM25 score; 0 when query is omitted (entries returned by recency). */
  score: number;
}

/**
 * Pluggable boundary for durable agent knowledge. Default impl writes
 * markdown files on disk; in-memory variant is for tests + transient
 * runs.
 *
 * Every method returns Effect for uniform error handling. Errors come
 * back as `MemoryError` with an `op`/`reason` discriminator.
 */
export interface MemoryAdapter {
  readonly id: string;
  /**
   * Upsert by `id`. When `id` is omitted a fresh ULID is generated.
   * Returns the persisted entry (with id, timestamps populated).
   */
  put(draft: MemoryDraft): Effect.Effect<MemoryEntry, MemoryError, never>;
  get(id: string): Effect.Effect<MemoryEntry | null, MemoryError, never>;
  /** Ranked search (BM25 when `query` set, recency otherwise). */
  search(opts: SearchOpts): Effect.Effect<ReadonlyArray<MemoryHit>, MemoryError, never>;
  /** Unranked list with the same filters as `search` minus `query`. */
  list(filter: Omit<SearchOpts, "query">): Effect.Effect<ReadonlyArray<MemoryEntry>, MemoryError, never>;
  /** Returns `false` if the id wasn't present. */
  forget(id: string): Effect.Effect<boolean, MemoryError, never>;
  /** Flush pending writes / release resources. Idempotent. */
  close(): Effect.Effect<void, MemoryError, never>;
}

/** Crockford base32 ULID alphabet. Used to validate `id`. */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Allowed shape for `agentId` and `runId` when used as a path segment. */
export const ID_SEGMENT_RE = /^[a-zA-Z0-9_-]{1,64}$/;
