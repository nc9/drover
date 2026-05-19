import type { MemoryEntry, MemoryScope, SearchOpts } from "./adapter.ts";

/**
 * Shared filter predicate used by both adapters. Implements scope/agent/
 * run filtering identically so the two impls behave the same.
 */
export function matches(entry: MemoryEntry, opts: SearchOpts, currentAgentId?: string): boolean {
  const scopes = effectiveScopes(opts);
  if (!scopes.includes(entry.scope)) return false;

  // Scope-specific filters
  if (entry.scope === "agent" || entry.scope === "run") {
    // Always confine to the calling agent — no cross-agent leaks.
    const wanted = opts.agentId ?? currentAgentId;
    if (wanted && entry.agentId !== wanted) return false;
  }
  if (entry.scope === "run") {
    if (!opts.runId || entry.runId !== opts.runId) return false;
  }

  if (opts.kinds && opts.kinds.length > 0 && !opts.kinds.includes(entry.kind)) {
    return false;
  }
  if (opts.tags && opts.tags.length > 0) {
    const wantedTags = new Set(opts.tags.map((t) => t.toLowerCase()));
    const entryTags = new Set((entry.tags ?? []).map((t) => t.toLowerCase()));
    let hit = false;
    for (const t of entryTags) if (wantedTags.has(t)) { hit = true; break; }
    if (!hit) return false;
  }
  return true;
}

export function effectiveScopes(opts: SearchOpts): ReadonlyArray<MemoryScope> {
  if (opts.scopes && opts.scopes.length > 0) return opts.scopes;
  return opts.runId ? ["global", "agent", "run"] : ["global", "agent"];
}

/** Stable sort by `updatedAt ?? createdAt` desc — most recent first. */
export function byRecency(a: MemoryEntry, b: MemoryEntry): number {
  return (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt);
}
