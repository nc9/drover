import { Type } from "@sinclair/typebox";
import {
  defineTool,
  type HarnessEvent,
  type ToolDef,
  type ToolResult,
} from "@drover/core";
import { Effect } from "effect";

import type { MemoryAdapter, MemoryHit, MemoryKind, MemoryScope } from "./adapter.ts";

const ScopeLiteral = Type.Union([
  Type.Literal("global"),
  Type.Literal("agent"),
  Type.Literal("run"),
]);
const KindLiteral = Type.Union([
  Type.Literal("user"),
  Type.Literal("feedback"),
  Type.Literal("project"),
  Type.Literal("reference"),
]);

const RememberInput = Type.Object({
  scope: ScopeLiteral,
  kind: KindLiteral,
  summary: Type.String({
    minLength: 1,
    maxLength: 200,
    description: "≤200 char one-liner — what the rule/fact is.",
  }),
  body: Type.String({
    minLength: 1,
    maxLength: 4000,
    description:
      "Markdown body. Lead with the rule, then a **Why:** line and a **How to apply:** line.",
  }),
  tags: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
  id: Type.Optional(
    Type.String({
      description: "Pass an existing memory id to update it; omit to create a new one.",
    }),
  ),
});

const RecallInput = Type.Object({
  query: Type.Optional(
    Type.String({ maxLength: 500, description: "BM25 query. Omit to list by recency." }),
  ),
  scopes: Type.Optional(Type.Array(ScopeLiteral)),
  kinds: Type.Optional(Type.Array(KindLiteral)),
  tags: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

const ForgetInput = Type.Object({
  id: Type.String({ description: "ULID of the memory to delete." }),
});

export interface RememberToolOptions {
  adapter: MemoryAdapter;
  agentId: string;
  runId: string;
  /** Optional emit hook for `memory_written` events. */
  emit?: (event: HarnessEvent) => void;
}

export function rememberTool(opts: RememberToolOptions): ToolDef<typeof RememberInput> {
  return defineTool({
    id: "remember",
    description:
      "Save a memory only when the lesson is non-obvious AND will apply to future runs. " +
      "Lead the body with the rule, then a **Why:** line and a **How to apply:** line. " +
      "Don't save what's already in the code or commit log. Scope: 'global' (cross-agent), " +
      "'agent' (this agent), 'run' (this run only).",
    inputSchema: RememberInput,
    execute: (input) =>
      Effect.gen(function* () {
        if (input.scope === "run" && !opts.runId) {
          return {
            content: "scope 'run' is not available — no runId on the context.",
            isError: true,
            data: { reason: "no_run_id" },
          };
        }
        const draft: import("./adapter.ts").MemoryDraft = {
          scope: input.scope,
          kind: input.kind,
          summary: input.summary,
          body: input.body,
          ...(input.tags ? { tags: input.tags } : {}),
          ...(input.id ? { id: input.id } : {}),
          ...(input.scope === "agent" || input.scope === "run"
            ? { agentId: opts.agentId }
            : {}),
          ...(input.scope === "run" ? { runId: opts.runId } : {}),
        };
        const result = yield* Effect.either(opts.adapter.put(draft));
        if (result._tag === "Left") {
          return {
            content: `remember failed: ${result.left.message}`,
            isError: true,
            data: { reason: result.left.reason, op: result.left.op },
          } as ToolResult;
        }
        const entry = result.right as Awaited<ReturnType<typeof opts.adapter.put> extends Effect.Effect<infer R, infer _E, infer _R> ? Promise<R> : never>;
        if (opts.emit) {
          try {
            opts.emit({
              kind: "memory_written",
              runId: opts.runId,
              entry: {
                id: entry.id,
                scope: entry.scope,
                kind: entry.kind,
                summary: entry.summary,
              },
              ts: Date.now(),
            });
          } catch {
            /* observation — swallow */
          }
        }
        return {
          content: `saved ${entry.scope}/${entry.kind} memory '${entry.id}'.`,
          data: { id: entry.id, scope: entry.scope, kind: entry.kind },
        } as ToolResult;
      }),
  });
}

export interface RecallToolOptions {
  adapter: MemoryAdapter;
  agentId: string;
  /** Empty string when called outside a run context. */
  runId: string;
  emit?: (event: HarnessEvent) => void;
  /** Default `limit` if the model doesn't specify. Default 10. */
  defaultLimit?: number;
}

export function recallTool(opts: RecallToolOptions): ToolDef<typeof RecallInput> {
  const defaultLimit = opts.defaultLimit ?? 10;
  return defineTool({
    id: "recall",
    description:
      "Search saved memories. Omit `query` to list by recency. Default scopes: " +
      "global + agent (and the active run when one is set). Pass `scopes` to override.",
    inputSchema: RecallInput,
    execute: (input) =>
      Effect.gen(function* () {
        // Default scopes mirror `effectiveScopes` in filter.ts: global+agent
        // when no run is active, all three otherwise. Keeping this in sync
        // with the adapter contract avoids run-scope memories silently
        // missing from recall results.
        const scopes: ReadonlyArray<MemoryScope> =
          input.scopes && input.scopes.length > 0
            ? (input.scopes as ReadonlyArray<MemoryScope>)
            : opts.runId
              ? ["global", "agent", "run"]
              : ["global", "agent"];
        const result = yield* Effect.either(
          opts.adapter.search({
            ...(input.query ? { query: input.query } : {}),
            scopes,
            agentId: opts.agentId,
            ...(opts.runId ? { runId: opts.runId } : {}),
            ...(input.kinds ? { kinds: input.kinds as ReadonlyArray<MemoryKind> } : {}),
            ...(input.tags ? { tags: input.tags } : {}),
            limit: input.limit ?? defaultLimit,
          }),
        );
        if (result._tag === "Left") {
          return {
            content: `recall failed: ${result.left.message}`,
            isError: true,
            data: { reason: result.left.reason },
          } as ToolResult;
        }
        const hits = result.right as ReadonlyArray<MemoryHit>;
        if (opts.emit) {
          try {
            opts.emit({
              kind: "memory_recalled",
              runId: opts.runId,
              query: input.query ?? null,
              scopes,
              hits: hits.map((h) => ({ id: h.id, scope: h.scope, score: h.score })),
              ts: Date.now(),
            });
          } catch {
            /* observation — swallow */
          }
        }
        return {
          content: formatHits(hits, scopes),
          data: { hits: hits.map((h) => ({ id: h.id, scope: h.scope, score: h.score })) },
        } as ToolResult;
      }),
  });
}

export interface ForgetToolOptions {
  adapter: MemoryAdapter;
  agentId: string;
  /** Restrict deletion to memories owned by this agent (or global). */
  enforceOwnership?: boolean;
}

export function forgetTool(opts: ForgetToolOptions): ToolDef<typeof ForgetInput> {
  const enforceOwnership = opts.enforceOwnership ?? true;
  return defineTool({
    id: "forget",
    description:
      "Delete a memory by id. Irreversible. Only call when an entry is wrong or " +
      "stale — prefer updating via `remember(id=..., ...)` for corrections.",
    inputSchema: ForgetInput,
    execute: (input) =>
      Effect.gen(function* () {
        if (enforceOwnership) {
          const existing = yield* Effect.either(opts.adapter.get(input.id));
          if (existing._tag === "Left") {
            return {
              content: `forget failed: ${existing.left.message}`,
              isError: true,
              data: { reason: existing.left.reason },
            } as ToolResult;
          }
          const entry = existing.right;
          if (entry && entry.scope !== "global" && entry.agentId !== opts.agentId) {
            return {
              content: `cannot forget '${input.id}' — owned by a different agent.`,
              isError: true,
              data: { reason: "not_owned" },
            } as ToolResult;
          }
        }
        const r = yield* Effect.either(opts.adapter.forget(input.id));
        if (r._tag === "Left") {
          return {
            content: `forget failed: ${r.left.message}`,
            isError: true,
            data: { reason: r.left.reason },
          } as ToolResult;
        }
        return {
          content: r.right ? `forgot memory '${input.id}'.` : `no memory '${input.id}' to forget.`,
          data: { id: input.id, removed: r.right },
        } as ToolResult;
      }),
  });
}

function formatHits(hits: ReadonlyArray<MemoryHit>, scopes: ReadonlyArray<MemoryScope>): string {
  if (hits.length === 0) {
    return `(no memories matched in scopes: ${scopes.join(", ")})`;
  }
  const lines: string[] = [`## Recalled (${hits.length} entries, scopes: ${scopes.join(", ")})`, ""];
  for (const h of hits) {
    const head = `### [${h.scope} · ${h.kind}] ${h.summary}`;
    const meta = `score: ${h.score.toFixed(2)} · id: ${h.id}${
      h.tags && h.tags.length > 0 ? ` · tags: ${h.tags.join(", ")}` : ""
    }`;
    lines.push(head, meta, "", h.body, "");
  }
  return lines.join("\n").trimEnd();
}
