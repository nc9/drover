import { StorageError } from "@drover/core";
import { Effect } from "effect";

import type {
  CheckpointRow,
  EventRow,
  PendingConfirmationRow,
  RunListFilter,
  RunRow,
  StorageAdapter,
} from "./adapter.ts";

/**
 * In-process Map-based store. Use for tests and short-lived processes
 * (the eval runner, smoke scripts) where durability isn't required.
 * Crash = data gone.
 */
export function createMemoryStorage(): StorageAdapter {
  const runs = new Map<string, RunRow>();
  const events = new Map<string, EventRow[]>();
  const checkpoints = new Map<string, CheckpointRow[]>();
  const confirmations = new Map<string, PendingConfirmationRow>();

  const confirmKey = (runId: string, toolUseId: string): string => `${runId}:${toolUseId}`;

  return {
    id: "memory",
    createRun: (row) =>
      Effect.sync(() => {
        runs.set(row.id, { ...row });
        events.set(row.id, []);
        checkpoints.set(row.id, []);
      }),
    updateRun: (id, patch) =>
      Effect.suspend(() => {
        const existing = runs.get(id);
        if (!existing) {
          return Effect.fail(
            new StorageError({ runId: id, op: "updateRun", message: "run not found" }),
          );
        }
        runs.set(id, { ...existing, ...patch });
        return Effect.void;
      }),
    appendEvent: (event) =>
      Effect.sync(() => {
        const list = events.get(event.runId);
        if (!list) {
          events.set(event.runId, [event]);
        } else {
          list.push(event);
        }
      }),
    saveCheckpoint: (cp) =>
      Effect.sync(() => {
        const list = checkpoints.get(cp.runId);
        if (!list) checkpoints.set(cp.runId, [cp]);
        else list.push(cp);
      }),
    loadRun: (id) => Effect.sync(() => runs.get(id) ?? null),
    loadLatestCheckpoint: (runId) =>
      Effect.sync(() => {
        const list = checkpoints.get(runId);
        if (!list || list.length === 0) return null;
        return list[list.length - 1] ?? null;
      }),
    listEvents: (runId) => Effect.sync(() => events.get(runId) ?? []),
    listRuns: (filter) =>
      Effect.sync(() => {
        let all = Array.from(runs.values());
        if (filter?.status?.length) {
          const set = new Set(filter.status);
          all = all.filter((r) => set.has(r.status));
        }
        if (filter?.agentId) all = all.filter((r) => r.agentId === filter.agentId);
        if (filter?.parentRunId === null) all = all.filter((r) => !r.parentRunId);
        else if (filter?.parentRunId) all = all.filter((r) => r.parentRunId === filter.parentRunId);
        if (filter?.startedAfter !== undefined) {
          const cutoff = filter.startedAfter;
          all = all.filter((r) => r.startedAt >= cutoff);
        }
        all.sort((a, b) => b.startedAt - a.startedAt);
        const offset = filter?.offset ?? 0;
        const limit = filter?.limit ?? all.length;
        return all.slice(offset, offset + limit);
      }),
    createPendingConfirmation: (row) =>
      Effect.sync(() => {
        confirmations.set(confirmKey(row.runId, row.toolUseId), { ...row });
      }),
    resolvePendingConfirmation: (runId, toolUseId, result, resolvedAt) =>
      Effect.suspend(() => {
        const k = confirmKey(runId, toolUseId);
        const row = confirmations.get(k);
        if (!row) {
          return Effect.fail(
            new StorageError({
              runId,
              op: "resolvePendingConfirmation",
              message: `no pending confirmation for tool_use_id=${toolUseId}`,
            }),
          );
        }
        confirmations.set(k, { ...row, result, resolvedAt });
        return Effect.void;
      }),
    close: () => Effect.void,
  };
}
