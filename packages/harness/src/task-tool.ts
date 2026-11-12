import { Type } from "@sinclair/typebox";
import {
  type AgentSpec,
  type AnyToolDef,
  defineTool,
  SubagentLimitError,
  type RunContext,
  type ToolResult,
} from "@droveragent/core";
import { Effect } from "effect";

import { runAgentEffect, type HarnessDeps } from "./run.ts";

/**
 * Resolves agent specs by id at spawn time. Static maps satisfy this
 * (just wrap in a function); dynamic agent registries (LLM-composed
 * specs cached by id) plug in here too.
 */
export interface AgentRegistry {
  resolve(id: string): AgentSpec | undefined;
}

/** Build a registry from a plain map. */
export function staticRegistry(agents: Readonly<Record<string, AgentSpec>>): AgentRegistry {
  return {
    resolve: (id) => agents[id],
  };
}

export interface TaskToolOptions {
  registry: AgentRegistry;
  /** Allowed `agent_type` values the parent may spawn. */
  allowedAgents: ReadonlyArray<string>;
  /** Hard cap on nesting depth. Parent at depth N spawns at depth N+1. */
  maxDepth?: number;
  /** Max concurrent children alive at once across this parent. */
  fanOut?: number;
  /** Per-tool defaults; forwarded to child `runAgentEffect`. */
  deps: HarnessDeps;
  /**
   * Emit callback for the PARENT's event stream. taskTool uses this to
   * surface `subagent_start` and `subagent_end` boundary events so the
   * parent's timeline reflects subagent lifecycle. Child internal events
   * are NOT mirrored — too noisy — but the boundary markers + tool_call
   * pair for the `task` invocation are enough to navigate to the child
   * run by `childRunId` in observers.
   */
  parentEmit?: (event: import("@droveragent/core").HarnessEvent) => void;
  /**
   * The parent's plugins. Those with `inheritToSubagents` also run in the child
   * (unless it has one with the same id), each child being its own run.
   */
  parentPlugins?: ReadonlyArray<import("@droveragent/core").HarnessPlugin>;
  /**
   * Child sequence numbers already used by earlier invocations of this parent run (a resume or
   * continuation): the first child of this invocation is `childSeqStart + 1`. The harness passes
   * the number of `task` calls in the checkpoint; with storage, the highest stored child id of the
   * parent also counts (see `taskTool`).
   */
  childSeqStart?: number;
}

/** Default subagent nesting depth — also surfaced in the `subagents` prompt fragment. */
export const DEFAULT_MAX_DEPTH = 2;
/** Default concurrent-children cap — also surfaced in the `subagents` prompt fragment. */
export const DEFAULT_FAN_OUT = 3;

const TaskInputSchema = Type.Object({
  agent_type: Type.String({ description: "id of the agent spec to spawn" }),
  prompt: Type.String({ description: "task description / instructions" }),
  input: Type.Optional(
    Type.Unknown({
      description:
        "JSON payload matching the child agent's inputSchema. Falls back to { prompt } if omitted.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "override the child's model alias" })),
  max_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

/**
 * Subagent-as-tool factory. Returns a `ToolDef` named `task` that
 * spawns a child run from inside the parent's loop. Depth / fanOut /
 * allowedAgents are enforced before the spawn begins; the child
 * inherits the parent's sandbox by default.
 *
 * Child run id is the parent's run id with a `:<n>` suffix (n is a
 * monotonically increasing per-parent counter, so the trace ancestor
 * is unambiguous and grandchildren get e.g. `parent:2:1`). The counter
 * continues across the parent's invocations (resume, continuation): it
 * starts above `childSeqStart` and, with storage, above the highest
 * child id the store already holds for the parent, so a later child
 * never reuses an earlier child's id (#97).
 */
export function taskTool(opts: TaskToolOptions): AnyToolDef {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const fanOut = opts.fanOut ?? DEFAULT_FAN_OUT;
  const allowed = new Set(opts.allowedAgents);

  let nextChildSeq = Math.max(0, Math.floor(opts.childSeqStart ?? 0));
  let inFlight = 0;
  // With storage, the stored children of the parent are read once (first spawn of this
  // invocation) and the counter moves above the highest `${parent}:<n>` found.
  let storedSeqChecked = false;
  const storedChildSeq = (parentRunId: string) =>
    opts.deps.storage
      ? opts.deps.storage.listRuns({ parentRunId }).pipe(
          Effect.map((rows) =>
            rows.reduce((max, r) => {
              const m = r.id.startsWith(`${parentRunId}:`)
                ? /^(\d+)$/.exec(r.id.slice(parentRunId.length + 1))
                : null;
              return m ? Math.max(max, Number(m[1])) : max;
            }, 0),
          ),
          // A storage outage must not block the spawn: the checkpoint count still applies.
          Effect.catchAll(() => Effect.succeed(0)),
        )
      : Effect.succeed(0);

  return defineTool({
    id: "task",
    description:
      "Spawn a child agent. Use this when the work needs a different role, tool set, or model than yours.",
    inputSchema: TaskInputSchema,
    execute: (input, ctx) =>
      Effect.gen(function* () {
        if (!allowed.has(input.agent_type)) {
          return yield* Effect.fail(
            new SubagentLimitError({
              runId: ctx.runId,
              reason: "not_allowed",
              attempted: input.agent_type,
            }),
          );
        }
        const childDepth = ctx.run.depth + 1;
        if (childDepth > maxDepth) {
          return yield* Effect.fail(
            new SubagentLimitError({
              runId: ctx.runId,
              reason: "depth",
              attempted: input.agent_type,
            }),
          );
        }
        if (inFlight >= fanOut) {
          return yield* Effect.fail(
            new SubagentLimitError({
              runId: ctx.runId,
              reason: "fan_out",
              attempted: input.agent_type,
            }),
          );
        }
        const spec = opts.registry.resolve(input.agent_type);
        if (!spec) {
          // Treat unregistered as not_allowed — same outcome.
          return yield* Effect.fail(
            new SubagentLimitError({
              runId: ctx.runId,
              reason: "not_allowed",
              attempted: input.agent_type,
            }),
          );
        }

        // Apply ad-hoc overrides.
        const inherited = (opts.parentPlugins ?? []).filter(
          (p) => p.inheritToSubagents && !(spec.plugins ?? []).some((q) => q.id === p.id),
        );
        const childSpec: AgentSpec = {
          ...spec,
          ...(inherited.length > 0 ? { plugins: [...(spec.plugins ?? []), ...inherited] } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.max_turns ? { quota: { ...spec.quota, maxTurns: input.max_turns } } : {}),
        };

        if (!storedSeqChecked) {
          storedSeqChecked = true;
          nextChildSeq = Math.max(nextChildSeq, yield* storedChildSeq(ctx.runId));
        }
        nextChildSeq += 1;
        const childRunId = `${ctx.runId}:${nextChildSeq}`;
        const childCtx: RunContext = {
          runId: childRunId,
          parentRunId: ctx.runId,
          depth: childDepth,
          cwd: ctx.run.cwd,
          env: ctx.run.env,
          signal: ctx.signal,
          ...(ctx.run.meta ? { meta: ctx.run.meta } : {}),
        };

        // Default child input shape: if the user gave one, use it;
        // otherwise wrap the prompt under `prompt`.
        const childInput = (input.input as Record<string, unknown> | undefined) ?? {
          prompt: input.prompt,
        };

        inFlight += 1;
        // Surface child lifecycle as subagent_start/end on the PARENT stream.
        // Per-event mirroring of child→parent is intentionally NOT done — the
        // parent gets boundary markers + the `task` tool_call pair. Observers
        // can follow `childRunId` if they want the full child stream.
        opts.parentEmit?.({
          kind: "subagent_start",
          runId: ctx.runId,
          childRunId,
          agentId: input.agent_type,
          ts: Date.now(),
        });
        let childStatus: "success" | "error" | "cancelled" = "success";
        try {
          // Child's own emit is a no-op — the harness still records the child's
          // events to storage internally when wired. The parent never sees them.
          const childEmit = (): void => {};
          const child = yield* Effect.either(
            runAgentEffect({
              spec: childSpec,
              input: childInput,
              ctx: childCtx,
              emit: childEmit,
              deps: opts.deps,
            }),
          );
          if (child._tag === "Left") {
            const err = child.left;
            childStatus = "error";
            return {
              content: `subagent ${input.agent_type} failed: ${(err as { _tag?: string })._tag ?? "Error"}: ${(err as { message?: string }).message ?? ""}`,
              isError: true,
              data: { childRunId, error: err },
            } satisfies ToolResult;
          }
          const r = child.right;
          if (r.status !== "success")
            childStatus = r.status === "cancelled" ? "cancelled" : "error";
          if (r.status !== "success") {
            return {
              content: `subagent ${input.agent_type} finished with status=${r.status}: ${r.error?.message ?? r.finalText.slice(0, 200)}`,
              isError: true,
              data: { childRunId, result: r },
            } satisfies ToolResult;
          }
          const body = r.output !== undefined ? JSON.stringify(r.output, null, 2) : r.finalText;
          return {
            content: body,
            isError: false,
            data: { childRunId, turns: r.turns, usage: r.usage },
          } satisfies ToolResult;
        } finally {
          inFlight -= 1;
          opts.parentEmit?.({
            kind: "subagent_end",
            runId: ctx.runId,
            childRunId,
            status: childStatus,
            ts: Date.now(),
          });
        }
      }) as Effect.Effect<ToolResult, never, never>,
  }) as AnyToolDef;
}
