import { Effect } from "effect";

import type { MemoryAdapter, MemoryEntry, MemoryScope } from "./adapter.ts";

export interface IndexOptions {
  /** Cap total entries. Default 30. */
  maxEntries?: number;
  /** Cap per-scope entries; default `maxEntries`. */
  maxPerScope?: number;
}

/**
 * Render the "Recalled memory" system-prompt block. Pulls scoped
 * summaries (global + agent) from the adapter, formats by scope, and
 * returns the markdown block. Returns empty string when no entries
 * match — caller can append blindly.
 */
export function renderMemoryIndex(
  adapter: MemoryAdapter,
  agentId: string,
  opts: IndexOptions = {},
): Effect.Effect<string, never, never> {
  const max = opts.maxEntries ?? 30;
  const perScope = opts.maxPerScope ?? max;

  return Effect.gen(function* () {
    const globalE = yield* Effect.either(
      adapter.list({ scopes: ["global"], limit: perScope }),
    );
    const agentE = yield* Effect.either(
      adapter.list({ scopes: ["agent"], agentId, limit: perScope }),
    );
    const globals = globalE._tag === "Right" ? (globalE.right as ReadonlyArray<MemoryEntry>) : [];
    const agents = agentE._tag === "Right" ? (agentE.right as ReadonlyArray<MemoryEntry>) : [];
    const total = globals.length + agents.length;
    if (total === 0) return "";

    const lines: string[] = ["", "## Recalled memory", ""];
    lines.push(
      "Scoped summaries — call `recall(query=..., scopes=...)` for the full body of any of these.",
    );
    lines.push("");
    const budget = Math.min(max, total);
    let used = 0;

    if (globals.length > 0 && used < budget) {
      lines.push("### Global");
      for (const e of globals) {
        if (used >= budget) break;
        lines.push(`- [${e.kind}] ${e.summary}`);
        used++;
      }
      lines.push("");
    }
    if (agents.length > 0 && used < budget) {
      lines.push(`### Agent (${agentId})`);
      for (const e of agents) {
        if (used >= budget) break;
        lines.push(`- [${e.kind}] ${e.summary}`);
        used++;
      }
      lines.push("");
    }
    return lines.join("\n").trimEnd();
  });
}

/** Internal helper — used by tests/tools when grouping hits for rendering. */
export function groupByScope<T extends { scope: MemoryScope }>(
  entries: ReadonlyArray<T>,
): Record<MemoryScope, T[]> {
  return entries.reduce(
    (acc, e) => {
      acc[e.scope].push(e);
      return acc;
    },
    { global: [] as T[], agent: [] as T[], run: [] as T[] } as Record<MemoryScope, T[]>,
  );
}
