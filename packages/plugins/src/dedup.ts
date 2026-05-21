/**
 * Tool-call dedup plugin. Caches the result of a previous identical
 * (`toolId` + `canonicalJsonHash(input)`) call within a single run so the
 * agent doesn't re-pay for redundant reads.
 *
 * **Allowlist-only.** Only side-effect-free reads are dedup-eligible
 * (`read`/`grep`/`find`/`ls` by default). Any tool NOT on the allowlist is
 * treated as potentially mutating: when one fires, the run's cache is
 * cleared in `beforeToolCall` — a `bash` exec can mutate any path a future
 * read might touch, so cached reads are stale afterwards.
 *
 * **Compose order.** List `truncate` before `dedup` in `spec.plugins` so
 * `dedup`'s `wrapTool` sits OUTSIDE `truncate`'s and caches the already
 * truncated, user-visible content. The truncation marker embedded in a
 * cached result still references the original `toolUseId`, and the
 * (run-scoped) `TruncateStore` keeps that entry — so `show_tool_result`
 * works on a deduped call without re-stashing.
 *
 * Caches are keyed by `runId` so concurrent runs (and subagents, which get
 * distinct run ids) never collide. Each run's cache is dropped on `onRunEnd`.
 */
import { createHash } from "node:crypto";
import type { AnyToolDef, HarnessPlugin, ToolResult } from "@drover/core";
import { Effect } from "effect";

import { canonicalJsonStringify } from "./internal/canonical-json.ts";

export const DEFAULT_DEDUP_ALLOWLIST: ReadonlyArray<string> = ["read", "grep", "find", "ls"];

export interface DedupOptions {
  /** Tool ids eligible for caching. Default: `read`, `grep`, `find`, `ls`. */
  allowlist?: ReadonlyArray<string>;
}

interface CacheEntry {
  result: ToolResult;
  originalToolUseId: string;
}

export interface DedupPlugin {
  plugin: HarnessPlugin;
  /** Diagnostic: number of cached entries for a run. */
  size(runId: string): number;
}

/**
 * sha256(canonicalJson(input)) — order-independent argument hash.
 */
export function hashToolArgs(input: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(input)).digest("hex");
}

export function dedupPlugin(opts: DedupOptions = {}): DedupPlugin {
  const allow = new Set(opts.allowlist ?? DEFAULT_DEDUP_ALLOWLIST);
  // runId -> ("toolId|argsHash" -> entry)
  const caches = new Map<string, Map<string, CacheEntry>>();
  const cacheFor = (runId: string): Map<string, CacheEntry> => {
    let c = caches.get(runId);
    if (!c) {
      c = new Map();
      caches.set(runId, c);
    }
    return c;
  };

  const beforeToolCall: NonNullable<HarnessPlugin["beforeToolCall"]> = (toolName, _input, ctx) =>
    Effect.sync(() => {
      // A non-allowlisted (potentially mutating) tool invalidates the run's
      // cache before it dispatches: cached reads are now potentially stale.
      if (!allow.has(toolName)) caches.get(ctx.runId)?.clear();
      return { kind: "allow" as const };
    });

  const wrapTool = (tool: AnyToolDef): AnyToolDef => {
    if (!allow.has(tool.id)) return tool;
    return {
      ...tool,
      execute: (input: unknown, ctx) =>
        Effect.gen(function* () {
          const cache = cacheFor(ctx.runId);
          const key = `${tool.id}|${hashToolArgs(input)}`;
          const hit = cache.get(key);
          if (hit) return prependDedupMarker(hit.result, hit.originalToolUseId);
          const result = yield* tool.execute(input, ctx);
          // Only cache successful results — errors may be transient
          // (filesystem race, abort) and shouldn't poison the cache.
          if (!result.isError) {
            cache.set(key, { result, originalToolUseId: ctx.toolUseId });
          }
          return result;
        }),
    };
  };

  return {
    plugin: {
      id: "dedup",
      beforeToolCall,
      wrapTool,
      onRunEnd: (_result, ctx) =>
        Effect.sync(() => {
          caches.delete(ctx.runId);
        }),
    },
    size: (runId) => caches.get(runId)?.size ?? 0,
  };
}

function prependDedupMarker(r: ToolResult, originalToolUseId: string): ToolResult {
  return {
    ...r,
    content: `[duplicate call — returning prior result; original tool_use_id="${originalToolUseId}"]\n\n${r.content}`,
  };
}
