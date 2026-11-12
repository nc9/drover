import { Effect } from "effect";

import type { MemoryAdapter, MemoryEntry, MemoryScope } from "./adapter.ts";

export interface IndexOptions {
  /** Cap total entries. Default 30. */
  maxEntries?: number;
  /** Cap per-scope entries; default `maxEntries`. */
  maxPerScope?: number;
  /**
   * Fence the entries that are not `trusted` (model-written memory inherits the
   * least trusted input it was derived from). Trusted entries stay as they are.
   * Without it nothing is fenced.
   */
  fence?: (section: string, text: string) => string;
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
    const globalE = yield* Effect.either(adapter.list({ scopes: ["global"], limit: perScope }));
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
    // Trusted lines raw; untrusted lines together in one fenced block.
    const emit = (entries: ReadonlyArray<MemoryEntry>): void => {
      const untrusted: string[] = [];
      for (const e of entries) {
        if (used >= budget) break;
        const line = `- [${e.kind}] ${e.summary}`;
        if (opts.fence && e.trusted !== true) untrusted.push(line);
        else lines.push(line);
        used++;
      }
      if (untrusted.length > 0) lines.push(opts.fence!("memory-index", untrusted.join("\n")));
    };

    if (globals.length > 0 && used < budget) {
      lines.push("### Global");
      emit(globals);
      lines.push("");
    }
    if (agents.length > 0 && used < budget) {
      lines.push(`### Agent (${agentId})`);
      emit(agents);
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
