import { MemoryError } from "@droveragent/core";
import { Effect } from "effect";

import type {
  MemoryAdapter,
  MemoryDraft,
  MemoryEntry,
  MemoryHit,
  SearchOpts,
} from "./adapter.ts";
import { ID_SEGMENT_RE, ULID_RE } from "./adapter.ts";
import { bm25, buildDoc, type Doc } from "./bm25.ts";
import { byRecency, matches } from "./filter.ts";
import { ulid } from "./ulid.ts";

/**
 * In-process Map-backed adapter. Use for tests and ephemeral runs where
 * durability isn't required.
 */
export function createInMemoryMemory(): MemoryAdapter {
  const entries = new Map<string, MemoryEntry>();
  const docs = new Map<string, Doc>();

  const persist = (entry: MemoryEntry): void => {
    entries.set(entry.id, entry);
    docs.set(entry.id, buildDoc(entry.id, entry.summary, entry.body, entry.tags));
  };

  return {
    id: "memory",
    put: (draft: MemoryDraft) =>
      Effect.suspend((): Effect.Effect<MemoryEntry, MemoryError, never> => {
        const validation = validateDraft(draft);
        if (validation) return Effect.fail(validation);

        const now = Date.now();
        const id = draft.id ?? ulid(now);
        const existing = entries.get(id);
        const entry: MemoryEntry = {
          id,
          scope: draft.scope,
          ...(draft.agentId !== undefined ? { agentId: draft.agentId } : {}),
          ...(draft.runId !== undefined ? { runId: draft.runId } : {}),
          kind: draft.kind,
          summary: draft.summary,
          body: draft.body,
          ...(draft.tags && draft.tags.length > 0 ? { tags: [...draft.tags] } : {}),
          createdAt: existing?.createdAt ?? now,
          ...(existing ? { updatedAt: now } : {}),
        };
        persist(entry);
        return Effect.succeed(entry);
      }),

    get: (id) =>
      Effect.sync(() => entries.get(id) ?? null),

    search: (opts: SearchOpts) =>
      Effect.sync((): ReadonlyArray<MemoryHit> => {
        const limit = opts.limit ?? 20;
        const filtered = [...entries.values()].filter((e) => matches(e, opts, opts.agentId));
        if (!opts.query || opts.query.length === 0) {
          return filtered
            .sort(byRecency)
            .slice(0, limit)
            .map((e) => ({ ...e, score: 0 }));
        }
        const allowed = new Set(filtered.map((e) => e.id));
        const corpus = [...docs.values()].filter((d) => allowed.has(d.id));
        const scored = bm25(opts.query, corpus);
        const byId = new Map(entries);
        return scored
          .slice(0, limit)
          .map((s) => ({ ...(byId.get(s.id) as MemoryEntry), score: s.score }));
      }),

    list: (filter) =>
      Effect.sync(() =>
        [...entries.values()]
          .filter((e) => matches(e, filter, filter.agentId))
          .sort(byRecency)
          .slice(0, filter.limit ?? 20),
      ),

    forget: (id) =>
      Effect.sync(() => {
        const had = entries.delete(id);
        docs.delete(id);
        return had;
      }),

    close: () => Effect.void,
  };
}

/**
 * Body length cap. Model-written entries (`user`/`feedback`/`project`)
 * stay terse — the `remember` tool schema caps them at 4000 too.
 * `reference` entries hold pointers and loaded documents (e.g. seeded
 * AGENTS.md / CLAUDE.md instruction files), which are legitimately
 * larger, so they get a much higher ceiling.
 */
const MAX_BODY_CHARS = { default: 4000, reference: 65536 } as const;

/**
 * Shared validation used by both adapters. Returns a `MemoryError` to
 * fail with, or null when the draft is valid.
 */
export function validateDraft(draft: MemoryDraft): MemoryError | null {
  if (draft.id !== undefined && !ULID_RE.test(draft.id)) {
    return new MemoryError({
      op: "put",
      reason: "invalid_id",
      message: `id must be a 26-char ULID (got '${draft.id}')`,
      id: draft.id,
    });
  }
  if (draft.scope === "agent" || draft.scope === "run") {
    if (!draft.agentId) {
      return new MemoryError({
        op: "put",
        reason: "invalid_scope",
        message: `scope '${draft.scope}' requires agentId`,
      });
    }
    if (!ID_SEGMENT_RE.test(draft.agentId)) {
      return new MemoryError({
        op: "put",
        reason: "path_escape",
        message: `agentId must match ${ID_SEGMENT_RE} (got '${draft.agentId}')`,
      });
    }
  }
  if (draft.scope === "run") {
    if (!draft.runId) {
      return new MemoryError({
        op: "put",
        reason: "invalid_scope",
        message: `scope 'run' requires runId`,
      });
    }
    if (!ID_SEGMENT_RE.test(draft.runId)) {
      return new MemoryError({
        op: "put",
        reason: "path_escape",
        message: `runId must match ${ID_SEGMENT_RE} (got '${draft.runId}')`,
      });
    }
  }
  if (draft.summary.length === 0 || draft.summary.length > 200) {
    return new MemoryError({
      op: "put",
      reason: "io",
      message: `summary must be 1-200 chars (got ${draft.summary.length})`,
    });
  }
  const maxBody =
    draft.kind === "reference" ? MAX_BODY_CHARS.reference : MAX_BODY_CHARS.default;
  if (draft.body.length === 0 || draft.body.length > maxBody) {
    return new MemoryError({
      op: "put",
      reason: "io",
      message: `body must be 1-${maxBody} chars (got ${draft.body.length})`,
    });
  }
  return null;
}
