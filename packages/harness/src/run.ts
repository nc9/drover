import {
  type AgentInput,
  type AgentOutput,
  type AgentSpec,
  type AnyToolDef,
  CancelledError,
  type HarnessError,
  type HarnessEvent,
  InputValidationError,
  LifecycleError,
  OutputValidationError,
  type RunContext,
  type RunResult,
  type RunStatus,
  type ToolExecutionContext,
  type Usage,
} from "@drover/core";
import type { CommandRegistry } from "@drover/commands";
import type { McpRuntime } from "@drover/mcp";
import { resolveModel, type ResolveOptions } from "@drover/model";
import type { SandboxAdapter } from "@drover/sandbox";
import {
  forgetTool,
  loadInstructionFiles,
  memoryRateLimitPlugin,
  recallTool,
  rememberTool,
  renderInstructionsBlock,
  renderMemoryIndex,
  seedInstructionFiles,
  type InstructionFile,
  type MemoryAdapter,
} from "@drover/memory";
import { createPromptEngine, loadPromptFile, type PromptScope } from "@drover/prompt";
import {
  renderSkillsBlock,
  skillLoadTool,
  skillResourceTool,
  type SkillRegistry,
} from "@drover/skills";
import type { CheckpointRow, StorageAdapter } from "@drover/storage";
import { builtinsById, type BuiltinToolId } from "@drover/tools";
import { Effect } from "effect";
import { runAgentLoop, runAgentLoopContinue } from "@mariozechner/pi-agent-core";
import { taskTool } from "./task-tool.ts";
import { runLifecycleSteps } from "./lifecycle.ts";
import type { AgentLoopConfig, AgentMessage } from "@mariozechner/pi-agent-core";
import type { KnownApi, Message, UserMessage } from "@mariozechner/pi-ai";
import { Value } from "@sinclair/typebox/value";
import { Kind, type TSchema } from "@sinclair/typebox";
import * as path from "node:path";

import { createTranslator, toPiTool, type PiEvent } from "./translate.ts";

/** Caller-provided emit hook. Errors thrown inside are swallowed (logged below). */
export type EventEmitter = (event: HarnessEvent) => void;

/** Per-run dependencies the harness needs. */
export interface HarnessDeps {
  sandbox: SandboxAdapter;
  /** Override the default alias map. */
  modelAliases?: ResolveOptions["aliases"];
  /** Override the environment seen by the model resolver. */
  env?: ResolveOptions["env"];
  /**
   * Host-injected, already-resolved models keyed by spec name. Checked
   * before alias / slug / builtin lookup — lets a host with its own role
   * resolver supply a constructed pi-ai model + key directly.
   */
  preResolvedModels?: ResolveOptions["preResolved"];
  /**
   * Registry for spawning subagents via the auto-injected `task` tool.
   * Required when any spec in the run tree uses `subagents`.
   */
  agentRegistry?: import("./task-tool.ts").AgentRegistry;
  /**
   * Optional persistence. When provided, the harness persists run row +
   * events + post-turn checkpoints. Storage errors are logged but never
   * crash the run — observability shouldn't break execution.
   */
  storage?: StorageAdapter;
  /**
   * Skill registry. When provided AND the spec declares `skills`, the
   * harness auto-injects a `skill_load` tool gated by the spec's allowlist
   * and appends an "Available skills" section to the system prompt.
   */
  skills?: SkillRegistry;
  /**
   * Memory adapter. When provided AND `spec.memory?.enabled === true`, the
   * harness auto-injects `remember` / `recall` (and optionally `forget`),
   * appends a scoped memory index to the system prompt, and applies the
   * rate-limit plugin if `writesPerTurn > 0`.
   */
  memory?: MemoryAdapter;
  /**
   * Connected MCP runtime. When provided AND the spec declares
   * `mcpServers`, every tool from the allowlisted servers is composed
   * into the agent's toolset with `<serverId>__<toolName>` prefixing.
   */
  mcpRuntime?: McpRuntime;
  /**
   * Command registry. Consumed by `spec.lifecycle` steps of kind
   * `command`; the spec's `commands` array is the per-agent allowlist.
   */
  commands?: CommandRegistry;
}

export interface RunArgs<S extends AgentSpec<TSchema, TSchema>> {
  spec: S;
  input: AgentInput<S>;
  ctx: RunContext;
  emit: EventEmitter;
  deps: HarnessDeps;
  /**
   * Resume from a previously-saved checkpoint instead of starting fresh.
   * When set: input validation is skipped, the run row is reused (no
   * createRun), pi's `runAgentLoopContinue` is used with the saved
   * messages, and counters initialise from the checkpoint.
   */
  resumeFrom?: CheckpointRow;
  /**
   * Mutable holder the facade flips when `handle.pause()` is called.
   * When the loop exits with `requested === true`, the terminal status
   * is `paused` rather than `cancelled` — so resume can pick up later.
   */
  pauseFlag?: { requested: boolean };
}

const DEFAULT_OUTPUT_RETRIES = 2;

/** Which run budget tripped, with its configured ceiling and the breaching value. */
type QuotaBreach = {
  dimension: "turns" | "duration" | "cost";
  limit: number;
  observed: number;
};

/** Stateless engine — registered builtins only; run state travels per render. */
const promptEngine = createPromptEngine();

/**
 * Build the `PromptScope` a template renders against, from resolved run
 * state. `skills` / `memory` are populated only when both the spec opts in
 * and the dependency is wired — otherwise their builtins render empty.
 */
export function buildPromptScope(args: {
  spec: AgentSpec;
  ctx: RunContext;
  deps: HarnessDeps;
  modelId: string;
  toolIds: ReadonlyArray<string>;
  instructionFiles: ReadonlyArray<InstructionFile>;
}): PromptScope {
  const { spec, ctx, deps, modelId, toolIds, instructionFiles } = args;
  return {
    agent: { id: spec.id },
    run: { runId: ctx.runId, cwd: ctx.cwd },
    model: modelId,
    tools: toolIds,
    ...(instructionFiles.length > 0 ? { instructions: instructionFiles } : {}),
    ...(deps.skills && spec.skills && spec.skills.length > 0
      ? { skills: { registry: deps.skills, allowed: spec.skills } }
      : {}),
    ...(deps.memory && spec.memory?.enabled
      ? {
          memory: {
            adapter: deps.memory,
            agentId: spec.id,
            maxEntries: spec.memory.maxIndexEntries ?? 30,
          },
        }
      : {}),
  };
}

/**
 * The main Effect-native run loop. Composes tools, validates input,
 * drives pi-agent-core, validates output (with retry budget), and
 * returns a typed `RunResult`.
 *
 * Out of scope for v0: MCP servers, skills, subagents, plugin hooks.
 * Those slot in by composing additional tools into the toolset and
 * adding before/after intercepts around the existing pi sink.
 */
export function runAgentEffect<S extends AgentSpec<TSchema, TSchema>>(
  args: RunArgs<S>,
): Effect.Effect<RunResult<AgentOutput<S>>, HarnessError, never> {
  return Effect.gen(function* () {
    const { spec, input, ctx, emit, deps, resumeFrom, pauseFlag } = args;
    const isResume = resumeFrom !== undefined;
    const startedAt = Date.now();
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const toolCalls: string[] = resumeFrom ? [...resumeFrom.toolCalls] : [];

    const explicitPlugins: ReadonlyArray<import("@drover/core").HarnessPlugin> = spec.plugins ?? [];
    // Auto-apply memory rate-limit when memory is enabled and writes-per-turn > 0.
    const writesPerTurn = spec.memory?.writesPerTurn ?? 1;
    const autoMemoryPlugin: import("@drover/core").HarnessPlugin | null =
      spec.memory?.enabled && deps.memory && writesPerTurn > 0
        ? memoryRateLimitPlugin({ writesPerTurn })
        : null;
    const plugins: ReadonlyArray<import("@drover/core").HarnessPlugin> = autoMemoryPlugin
      ? [...explicitPlugins, autoMemoryPlugin]
      : explicitPlugins;
    const storage = deps.storage;
    // Seq counter continues from the checkpoint to avoid collisions with the
    // events that were already persisted before pause. We add a small gap so
    // the run can be replayed in seq order without surprises.
    let nextSeq = resumeFrom ? resumeFrom.seq * 1000 + 1 : 0;

    const safeEmit = (e: HarnessEvent): void => {
      try {
        emit(e);
      } catch {
        /* observer errors must not crash the run */
      }
      for (const p of plugins) {
        if (!p.onEvent) continue;
        try {
          Effect.runSync(p.onEvent(e, ctx));
        } catch {
          /* observer failure must not crash run */
        }
      }
      // Persist; failures are swallowed so storage outages don't break runs.
      if (storage) {
        const seq = nextSeq++;
        Effect.runPromise(
          Effect.either(
            storage.appendEvent({ runId: ctx.runId, seq, ts: e.ts, kind: e.kind, payload: e }),
          ),
        ).catch(() => {});
      }
    };

    const specHash = hashSpec(spec);

    // Fresh-run persistence: create the row + validate input. Resumes skip
    // both — the row already exists and the input was decoded before.
    if (storage && !isResume) {
      const createResult = yield* Effect.either(
        storage.createRun({
          id: ctx.runId,
          ...(ctx.parentRunId ? { parentRunId: ctx.parentRunId } : {}),
          agentId: spec.id,
          specHash,
          status: "running",
          input,
          startedAt,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          ...(ctx.meta ? { meta: ctx.meta as Record<string, unknown> } : {}),
        }),
      );
      if (createResult._tag === "Left") void createResult.left;
    }
    if (storage && isResume) {
      // Flip status back to "running" so observers see the in-flight state.
      const r = yield* Effect.either(storage.updateRun(ctx.runId, { status: "running" }));
      if (r._tag === "Left") void r.left;
    }

    safeEmit({ kind: "run_start", runId: ctx.runId, agentId: spec.id, specHash, ts: Date.now() });

    if (!isResume && !Value.Check(spec.inputSchema, input)) {
      const issues = collectIssues(spec.inputSchema, input);
      return yield* Effect.fail(
        new InputValidationError({
          runId: ctx.runId,
          agentId: spec.id,
          issues,
        }),
      );
    }
    safeEmit({ kind: "input_validated", runId: ctx.runId, ts: Date.now() });

    const resolved = yield* resolveModel(spec.model, {
      runId: ctx.runId,
      ...(deps.modelAliases ? { aliases: deps.modelAliases } : {}),
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.preResolvedModels ? { preResolved: deps.preResolvedModels } : {}),
    });

    const tools = composeTools(spec, deps, plugins, safeEmit, ctx.runId);

    // Instruction files (AGENTS.md / CLAUDE.md ancestor chain). Loaded
    // fresh each run and seeded into memory as recall-able entries when an
    // adapter is wired — both side effects run regardless of how the
    // system prompt is assembled below. Fully opt-in via spec.instructionFiles.
    let instructionFilesList: ReadonlyArray<InstructionFile> = [];
    if (spec.instructionFiles) {
      instructionFilesList = yield* Effect.promise(() =>
        loadInstructionFiles({
          cwd: ctx.cwd,
          ...(spec.instructionFiles!.filenames
            ? { filenames: spec.instructionFiles!.filenames }
            : {}),
          ...(spec.instructionFiles!.root ? { root: spec.instructionFiles!.root } : {}),
          ...(spec.instructionFiles!.maxBytesPerFile !== undefined
            ? { maxBytesPerFile: spec.instructionFiles!.maxBytesPerFile }
            : {}),
        }),
      );
      if (deps.memory && spec.instructionFiles.seedMemory !== false) {
        const seeded = yield* Effect.either(
          seedInstructionFiles(deps.memory, instructionFilesList),
        );
        if (seeded._tag === "Left") void seeded.left;
      }
    }

    const tplConfig = spec.promptTemplate;
    let systemPrompt: string;
    if (tplConfig && (tplConfig.source !== undefined || tplConfig.path !== undefined)) {
      // Template-driven assembly: the .md.liquid template owns layout and
      // renders drover builtins from run state. spec.systemPrompt is not
      // used on this path. A promptTemplate config with neither source nor
      // path is ignored — assembly falls through to the default branch.
      let tplSource: string;
      if (tplConfig.source !== undefined) {
        tplSource = tplConfig.source;
      } else {
        const p = tplConfig.path!;
        const abs = path.isAbsolute(p) ? p : path.join(ctx.cwd, p);
        tplSource = yield* Effect.promise(() => loadPromptFile(abs));
      }
      const promptScope = buildPromptScope({
        spec,
        ctx,
        deps,
        modelId: resolved.model.id,
        toolIds: tools.map((t) => t.id),
        instructionFiles: instructionFilesList,
      });
      const rendered = yield* Effect.promise(() =>
        promptEngine.render(tplSource, promptScope, {
          autoReorder: tplConfig.autoReorder ?? false,
        }),
      );
      systemPrompt = rendered.text;
      safeEmit({
        kind: "prompt_rendered",
        runId: ctx.runId,
        cacheablePrefixChars: rendered.cache.cacheablePrefixChars,
        totalChars: rendered.cache.totalChars,
        reordered: rendered.cache.reordered,
        warnings: rendered.cache.warnings.map((w) => w.message),
        ts: Date.now(),
      });
    } else {
      // Default assembly: base prompt + auto-blocks (instructions, skills,
      // memory index) joined. Each block renderer returns "" when empty.
      const promptSource = spec.systemPrompt;
      const basePrompt: string =
        typeof promptSource === "string"
          ? promptSource
          : yield* Effect.promise(async (): Promise<string> => await promptSource(ctx));
      const skillsBlock =
        spec.skills && spec.skills.length > 0 && deps.skills
          ? renderSkillsBlock(deps.skills, spec.skills)
          : "";
      const instructionsBlock = renderInstructionsBlock(instructionFilesList);
      const memoryBlock =
        spec.memory?.enabled && spec.memory.includeIndex !== false && deps.memory
          ? yield* renderMemoryIndex(deps.memory, spec.id, {
              maxEntries: spec.memory.maxIndexEntries ?? 30,
            })
          : "";
      systemPrompt = [basePrompt, instructionsBlock, skillsBlock, memoryBlock]
        .filter((s) => s.length > 0)
        .join("\n");
    }

    // Scope for deterministic lifecycle steps (commands render against it).
    const lifecycleScope = buildPromptScope({
      spec,
      ctx,
      deps,
      modelId: resolved.model.id,
      toolIds: tools.map((t) => t.id),
      instructionFiles: instructionFilesList,
    });

    // Deterministic `init` lifecycle — resolve steps to text blocks that
    // prepend to the opening user turn. Skipped on resume (the blocks are
    // already in the checkpointed message history). A misconfigured step
    // fails the run with a `LifecycleError`.
    let initBlocks: ReadonlyArray<string> = [];
    if (!isResume && spec.lifecycle?.init && spec.lifecycle.init.length > 0) {
      initBlocks = yield* Effect.tryPromise({
        try: (): Promise<string[]> =>
          runLifecycleSteps({
            phase: "init",
            steps: spec.lifecycle!.init!,
            runId: ctx.runId,
            allowedCommands: spec.commands ?? [],
            allowedSkills: spec.skills ?? [],
            allowedMcpServers: spec.mcpServers ?? [],
            deps,
            engine: promptEngine,
            scope: lifecycleScope,
          }),
        catch: (err): LifecycleError =>
          err instanceof LifecycleError
            ? err
            : new LifecycleError({
                runId: ctx.runId,
                phase: "init",
                step: "_",
                message: (err as Error).message,
              }),
      });
    }

    const userPrompt = buildUserPrompt(spec, input);
    const composedPrompt =
      initBlocks.length > 0 ? [...initBlocks, userPrompt].join("\n\n") : userPrompt;

    // Convert tools to pi shape.
    const buildToolCtx = (
      toolCallId: string,
      signal?: AbortSignal,
    ): ToolExecutionContext & {
      run: RunContext;
    } => ({
      runId: ctx.runId,
      toolUseId: toolCallId,
      cwd: ctx.cwd,
      env: ctx.env,
      signal: signal ?? ctx.signal,
      run: ctx,
    });
    const piTools = tools.map((t) => toPiTool(t, buildToolCtx));

    // Translation state + lastAssistantText tracking for output validation.
    // Counters (turn, usage, retries) initialise from the checkpoint on resume.
    const translator = createTranslator(ctx.runId, resumeFrom ? resumeFrom.seq : 0);
    const lastAssistant: { text: string | null } = { text: null };
    const lastUsage: { value: Usage } = {
      value: resumeFrom ? { ...resumeFrom.usage } : { inputTokens: 0, outputTokens: 0 },
    };
    let retriesUsed = resumeFrom ? resumeFrom.retriesUsed : 0;
    const outputRetries = spec.outputRetries ?? DEFAULT_OUTPUT_RETRIES;
    const quota = spec.quota ?? {};
    // No default turn cap — turns are unbounded unless `quota.maxTurns` is
    // set explicitly. Duration / cost budgets remain the ambient backstops.
    const maxTurns = quota.maxTurns;

    // Why a run budget was exhausted. Set once (first breach wins) by the
    // duration timer or the in-`sink` turn/cost checks; read in the
    // post-loop section to resolve the terminal status. Boxed so a closure
    // write survives TS control-flow narrowing at the post-loop read site.
    const quotaBreach: { value: QuotaBreach | null } = { value: null };

    // Snapshot of pi's message list, updated each LLM call via transformContext.
    // Used to checkpoint state for resume. Seeded from the checkpoint on resume.
    const messagesSnapshot: { value: ReadonlyArray<AgentMessage> } = {
      value: resumeFrom ? (resumeFrom.messages as ReadonlyArray<AgentMessage>) : [],
    };

    const persistCheckpoint = (turn: number, ts: number): void => {
      if (!storage) return;
      Effect.runPromise(
        Effect.either(
          storage.saveCheckpoint({
            runId: ctx.runId,
            seq: turn,
            messages: messagesSnapshot.value,
            usage: lastUsage.value,
            toolCalls: [...toolCalls],
            retriesUsed,
            ts,
          }),
        ),
      ).catch(() => {});
    };

    const sink = (e: PiEvent): void => {
      // Track last assistant text live for output validation.
      if (e.type === "message_end") {
        const msg = e.message;
        if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
          lastAssistant.text = null;
          for (let i = msg.content.length - 1; i >= 0; i--) {
            const c = msg.content[i] as { type?: string; text?: string };
            if (c?.type === "text" && typeof c.text === "string") {
              lastAssistant.text = c.text;
              break;
            }
          }
        }
      }
      // Track tool calls in order.
      if (e.type === "tool_execution_start" && e.toolName) toolCalls.push(e.toolName);
      // Accumulate usage.
      if (e.type === "message_end") {
        const u = (
          e.message as { usage?: { input?: number; output?: number; cost?: { total?: number } } }
        )?.usage;
        if (u) {
          const next: Usage = {
            inputTokens: (lastUsage.value.inputTokens ?? 0) + (u.input ?? 0),
            outputTokens: (lastUsage.value.outputTokens ?? 0) + (u.output ?? 0),
          };
          const cost = (lastUsage.value.costUsd ?? 0) + (u.cost?.total ?? 0);
          if (cost > 0) next.costUsd = cost;
          lastUsage.value = next;
          // Cost ceiling — checked once per model response, after the
          // running total is updated. Aborts mid-turn if a tool batch is
          // still pending.
          if (quota.maxCostUsd !== undefined && (next.costUsd ?? 0) >= quota.maxCostUsd) {
            tripQuota({ dimension: "cost", limit: quota.maxCostUsd, observed: next.costUsd ?? 0 });
          }
        }
      }
      // Emit translated drover events. safeEmit fans out to plugin observers.
      for (const ev of translator.translate(e)) safeEmit(ev);
      // Persist checkpoint at the end of every turn — covers tool-using runs
      // (turn_end fires after each tool batch) and pure-text runs.
      if (e.type === "turn_end") {
        const turn = translator.currentTurn();
        persistCheckpoint(turn, Date.now());
        // Turn budget — abort the *next* turn from starting. The turn that
        // just completed keeps its output: the cap is a budget, not a
        // tripwire on a turn that produced a valid answer.
        if (maxTurns !== undefined && turn >= maxTurns) {
          tripQuota({ dimension: "turns", limit: maxTurns, observed: turn });
        }
      }
    };

    // Output-schema self-correction.
    const getFollowUpMessages = async (): Promise<UserMessage[]> => {
      if (ctx.signal.aborted) return [];
      // Open-schema agents have no structured-output contract — never push a
      // schema-correction turn at them.
      if (isOpenSchema(spec.outputSchema)) return [];
      if (retriesUsed >= outputRetries) return [];
      const text = lastAssistant.text;
      if (!text || text.trim().length === 0) return [];

      const decode = tryDecode(spec.outputSchema, text);
      if (decode.ok) return [];

      retriesUsed += 1;
      safeEmit({
        kind: "output_retry",
        runId: ctx.runId,
        attempt: retriesUsed,
        reason: decode.message,
        ts: Date.now(),
      });
      return [
        {
          role: "user",
          content: buildSchemaFeedback(decode.message),
          timestamp: Date.now(),
        },
      ];
    };

    // Plugin chain for pi's beforeToolCall. Walks plugins in order;
    // first `deny` wins. `allow` → pi sees `{}` (proceed). A plugin that
    // errors fails-closed (acts like deny) — observability shouldn't be
    // able to short-circuit policy.
    const beforeToolCall = plugins.some((p) => p.beforeToolCall)
      ? async (pCtx: {
          toolCall: { name: string; id?: string };
          args: unknown;
        }): Promise<{ block?: boolean; reason?: string }> => {
          const matchedTool = tools.find((t) => t.id === pCtx.toolCall.name);
          const meta = {
            ...(matchedTool ? { tool: matchedTool } : {}),
            ...(pCtx.toolCall.id !== undefined ? { toolUseId: pCtx.toolCall.id } : {}),
          };
          for (const p of plugins) {
            if (!p.beforeToolCall) continue;
            const decision = await Effect.runPromise(
              Effect.either(p.beforeToolCall(pCtx.toolCall.name, pCtx.args, ctx, meta)),
            );
            if (decision._tag === "Left") {
              return {
                block: true,
                reason: `plugin ${p.id} errored: ${(decision.left as { message?: string }).message ?? ""}`,
              };
            }
            const d = decision.right;
            if (d.kind === "deny") return { block: true, reason: d.reason };
            // allow → continue chain
          }
          return {};
        }
      : undefined;

    // afterToolCall: walk plugins in order; each may rewrite the tool result.
    const afterToolCall = plugins.some((p) => p.afterToolCall)
      ? async (aCtx: {
          toolCall: { name: string };
          args: unknown;
          result: { content: Array<{ type: string; text?: string }>; details?: unknown };
          isError: boolean;
        }): Promise<{
          content?: Array<{ type: "text"; text: string }>;
          details?: unknown;
          isError?: boolean;
        }> => {
          let current: import("@drover/core").ToolResult = {
            content: (aCtx.result.content ?? [])
              .map((c) => (typeof c.text === "string" ? c.text : ""))
              .join(""),
            isError: aCtx.isError,
            data: aCtx.result.details,
          };
          for (const p of plugins) {
            if (!p.afterToolCall) continue;
            const next = await Effect.runPromise(
              Effect.either(p.afterToolCall(aCtx.toolCall.name, aCtx.args, current, ctx)),
            );
            if (next._tag === "Right") current = next.right;
          }
          const out: {
            content?: Array<{ type: "text"; text: string }>;
            details?: unknown;
            isError?: boolean;
          } = {
            content: [{ type: "text", text: current.content }],
          };
          if (current.data !== undefined) out.details = current.data;
          if (current.isError !== undefined) out.isError = current.isError;
          return out;
        }
      : undefined;

    // Reasoning gate: pi-ai distinguishes a model declaring `reasoning: true`
    // (capability) from a per-call reasoning level (effort). Some reasoning
    // models — notably gpt-5-mini via openrouter — produce no final text when
    // called without an explicit level. Default to "medium" when the model
    // declares the capability and the caller hasn't picked a level.
    const effectiveReasoning =
      resolved.reasoning ??
      ((resolved.model as { reasoning?: boolean }).reasoning ? "medium" : undefined);

    // transformContext: pi calls this before each LLM call with the live
    // message list. We snapshot it here so post-turn checkpoints can persist
    // the exact state needed to resume via `runAgentLoopContinue`.
    const transformContext = storage
      ? async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
          messagesSnapshot.value = [...messages];
          return messages;
        }
      : undefined;

    const loopConfig: AgentLoopConfig = {
      model: resolved.model as never,
      convertToLlm: (messages: AgentMessage[]): Message[] => messages as Message[],
      apiKey: resolved.apiKey,
      toolExecution: "sequential",
      ...(effectiveReasoning ? { reasoning: effectiveReasoning } : {}),
      ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
      ...(resolved.maxTokens !== undefined ? { maxTokens: resolved.maxTokens } : {}),
      ...(resolved.cacheRetention ? { cacheRetention: resolved.cacheRetention } : {}),
      ...(transformContext ? { transformContext } : {}),
      ...(beforeToolCall ? { beforeToolCall: beforeToolCall as never } : {}),
      ...(afterToolCall ? { afterToolCall: afterToolCall as never } : {}),
      getFollowUpMessages,
    };

    const initialPrompt: UserMessage = {
      role: "user",
      content: composedPrompt,
      timestamp: Date.now(),
    };

    // Wall-clock timeout + abort handling. The timer/listener must stay armed
    // through the optional `postSuccess` lifecycle continuation —
    // `quota.maxDurationMs` is the budget for the *whole* run — so teardown is
    // an explicit, idempotent call made after `postSuccess`, not a `finally`
    // on the loop.
    const abortController = new AbortController();
    const onParentAbort = (): void => abortController.abort();
    if (ctx.signal.aborted) abortController.abort();
    else ctx.signal.addEventListener("abort", onParentAbort, { once: true });
    // Record a budget breach and abort the loop. First breach wins — the
    // post-loop section reads `quotaBreach` to pick the terminal status.
    const tripQuota = (b: QuotaBreach): void => {
      quotaBreach.value ??= b;
      abortController.abort();
    };
    const maxDurationMs = quota.maxDurationMs;
    const timeoutHandle =
      maxDurationMs !== undefined
        ? setTimeout(() => {
            tripQuota({
              dimension: "duration",
              limit: maxDurationMs,
              observed: Date.now() - startedAt,
            });
          }, maxDurationMs)
        : undefined;
    let abortCleaned = false;
    const cleanupAbort = (): void => {
      if (abortCleaned) return;
      abortCleaned = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      ctx.signal.removeEventListener("abort", onParentAbort);
    };

    // Run-level lifecycle: fire `onRunStart` once, after context assembly +
    // `init`, before the first model call. Observation only — failures and
    // defects are swallowed (and async effects awaited) so a metrics/webhook
    // hook can't crash the run.
    for (const p of plugins) {
      if (!p.onRunStart) continue;
      yield* p.onRunStart(ctx).pipe(Effect.catchAllCause(() => Effect.void));
    }

    // Treat the pi loop's rejection as a recoverable signal — the post-loop
    // section is responsible for choosing the final status (paused vs
    // cancelled vs error). Without this, an abort-mid-flight would short-
    // circuit before storage gets the "paused" mark.
    let loopError: Error | null = null;
    // Final message list — captured so a `postSuccess` lifecycle can continue
    // the loop from exactly where the agent stopped.
    let finalMessages: AgentMessage[] = [];
    yield* Effect.promise(async (): Promise<void> => {
      try {
        if (isResume) {
          finalMessages = await runAgentLoopContinue(
            {
              systemPrompt,
              messages: [...(resumeFrom!.messages as ReadonlyArray<AgentMessage>)],
              tools: piTools,
            },
            loopConfig,
            sink as (e: PiEvent) => void,
            abortController.signal,
          );
        } else {
          finalMessages = await runAgentLoop(
            [initialPrompt as AgentMessage],
            { systemPrompt, messages: [], tools: piTools },
            loopConfig,
            sink as (e: PiEvent) => void,
            abortController.signal,
          );
        }
      } catch (err) {
        loopError = err as Error;
      }
    });

    // Aggregate usage.
    usage.inputTokens = lastUsage.value.inputTokens;
    usage.outputTokens = lastUsage.value.outputTokens;
    if (lastUsage.value.costUsd !== undefined) usage.costUsd = lastUsage.value.costUsd;

    // Resolve terminal status. Priority order:
    //   1. pauseFlag → paused (resumable later via resumeAgent)
    //   2. caller cancellation → cancelled
    //   3. final text decodes → success (even at a quota breach — a turn
    //      that produced a valid answer is success; the budget is not a
    //      tripwire on the happy path)
    //   4. quota breach → quota
    //   5. genuine loop crash → error
    //   6. no final text → error
    //   7. final text fails schema → error
    // A quota abort makes pi throw, so `loopError` is set on every breach —
    // a genuine crash is `loopError && !breach`.
    let output: AgentOutput<S> | undefined;
    let status: RunStatus = "success";
    let errorOut: { tag: string; message: string } | undefined;

    const finalText = lastAssistant.text;

    if (pauseFlag?.requested) {
      status = "paused";
    } else if (ctx.signal.aborted) {
      status = "cancelled";
      errorOut = { tag: "CancelledError", message: "cancelled by caller" };
    } else {
      // Order matters. An enforced budget breach is terminal — it wins even
      // if the breaching turn happened to produce valid output (a blown
      // budget must not be reported as success). Then loop errors, then the
      // output check.
      const breach = quotaBreach.value;
      if (breach) {
        status = "quota";
        errorOut = {
          tag: "QuotaExceededError",
          message: `${breach.dimension} budget exceeded (limit ${breach.limit}, observed ${breach.observed})`,
        };
      } else if (loopError) {
        status = "error";
        errorOut = { tag: "LoopError", message: (loopError as Error).message };
      } else if (!finalText || finalText.trim().length === 0) {
        status = "error";
        errorOut = { tag: "OutputValidationError", message: "no final assistant text" };
      } else if (isOpenSchema(spec.outputSchema)) {
        // No structured-output contract — any non-empty final text succeeds;
        // `output` stays undefined and the caller reads `finalText`.
        safeEmit({ kind: "output_validated", runId: ctx.runId, ts: Date.now() });
      } else {
        const decoded = tryDecode(spec.outputSchema, finalText);
        if (decoded.ok) {
          output = decoded.value as AgentOutput<S>;
          safeEmit({ kind: "output_validated", runId: ctx.runId, ts: Date.now() });
        } else {
          status = "error";
          errorOut = { tag: "OutputValidationError", message: decoded.message };
        }
      }
    }

    // Deterministic `postSuccess` lifecycle — on a clean natural success,
    // append a closing turn and let the agent execute it with its tools.
    // The output was captured above, so these turns can't change it; they
    // are post-processing (lint, commit, …).
    if (
      status === "success" &&
      spec.lifecycle?.postSuccess &&
      spec.lifecycle.postSuccess.length > 0 &&
      finalMessages.length > 0
    ) {
      const postBlocks = yield* Effect.either(
        Effect.tryPromise({
          try: (): Promise<string[]> =>
            runLifecycleSteps({
              phase: "postSuccess",
              steps: spec.lifecycle!.postSuccess!,
              runId: ctx.runId,
              allowedCommands: spec.commands ?? [],
              allowedSkills: spec.skills ?? [],
              allowedMcpServers: spec.mcpServers ?? [],
              deps,
              engine: promptEngine,
              scope: lifecycleScope,
            }),
          catch: (err): LifecycleError =>
            err instanceof LifecycleError
              ? err
              : new LifecycleError({
                  runId: ctx.runId,
                  phase: "postSuccess",
                  step: "_",
                  message: (err as Error).message,
                }),
        }),
      );
      if (postBlocks._tag === "Left") {
        status = "error";
        errorOut = { tag: postBlocks.left._tag, message: postBlocks.left.message };
      } else if (postBlocks.right.length > 0) {
        const postMsg: UserMessage = {
          role: "user",
          content: postBlocks.right.join("\n\n"),
          timestamp: Date.now(),
        };
        // The run output is already captured and validated. Strip
        // `getFollowUpMessages` (output-schema self-correction) for the
        // continuation so a plain post-processing reply — a lint/commit
        // summary — can't fail the original schema and trigger correction
        // prompts inside the post-processing phase.
        const postLoopConfig: AgentLoopConfig = {
          ...loopConfig,
          getFollowUpMessages: async (): Promise<UserMessage[]> => [],
        };
        yield* Effect.promise(async (): Promise<void> => {
          try {
            await runAgentLoopContinue(
              {
                systemPrompt,
                messages: [...finalMessages, postMsg as AgentMessage],
                tools: piTools,
              },
              postLoopConfig,
              sink as (e: PiEvent) => void,
              abortController.signal,
            );
          } catch (err) {
            loopError = err as Error;
          }
        });
        if (loopError) {
          // The wall-clock timer stays armed through `postSuccess`, and the
          // shared `sink` keeps checking turns/cost — so a breach here is a
          // quota abort, not a crash. Mirror the main post-loop split.
          const breach = quotaBreach.value;
          if (breach) {
            status = "quota";
            errorOut = {
              tag: "QuotaExceededError",
              message: `${breach.dimension} budget exceeded (limit ${breach.limit}, observed ${breach.observed})`,
            };
          } else {
            status = "error";
            errorOut = { tag: "LoopError", message: (loopError as Error).message };
          }
        }
        // Re-aggregate usage — the `postSuccess` turns consumed tokens too.
        usage.inputTokens = lastUsage.value.inputTokens;
        usage.outputTokens = lastUsage.value.outputTokens;
        if (lastUsage.value.costUsd !== undefined) usage.costUsd = lastUsage.value.costUsd;
      }
    }

    // Wall-clock budget covered `init` + loop + `postSuccess`; safe to
    // disarm now. Idempotent — terminal paths below won't double-clear.
    cleanupAbort();

    // A `quota` status carries its `QuotaExceededError` in `errorOut` (set
    // in the post-loop block above) and is returned as a `RunResult` — the
    // run reached a terminal state, it just exhausted a budget.
    const turns = translator.currentTurn();

    const durationMs = Date.now() - startedAt;
    const endedAt = Date.now();
    safeEmit({ kind: "run_end", runId: ctx.runId, status, ts: endedAt });

    // Final persistence pass — write terminal status + output/error + cumulative
    // counters. Failure is non-fatal; the run already succeeded from the
    // caller's perspective.
    if (storage) {
      const patch: Parameters<NonNullable<typeof storage>["updateRun"]>[1] = {
        status,
        endedAt,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        costUsd: usage.costUsd ?? 0,
      };
      if (output !== undefined) patch.output = output;
      if (errorOut) patch.error = errorOut;
      const r = yield* Effect.either(storage.updateRun(ctx.runId, patch));
      if (r._tag === "Left") void r.left;
    }

    const result: RunResult<AgentOutput<S>> = {
      runId: ctx.runId,
      status,
      finalText: finalText ?? "",
      turns,
      durationMs,
      usage,
      toolCalls,
    };
    if (output !== undefined) result.output = output;
    if (errorOut) result.error = errorOut;

    // Run-level lifecycle: fire `onRunEnd` once, after the loop +
    // `postSuccess` and terminal resolution. Observation only — failures and
    // defects are swallowed (and async effects awaited).
    for (const p of plugins) {
      if (!p.onRunEnd) continue;
      yield* p.onRunEnd(result, ctx).pipe(Effect.catchAllCause(() => Effect.void));
    }

    return result;
  });
}

function composeTools(
  spec: AgentSpec,
  deps: HarnessDeps,
  plugins: ReadonlyArray<import("@drover/core").HarnessPlugin>,
  parentEmit: (event: HarnessEvent) => void,
  runId: string,
): ReadonlyArray<AnyToolDef> {
  const byId = builtinsById(deps.sandbox);
  const wanted = new Set(spec.tools);
  let out: AnyToolDef[] = [];

  // Built-ins requested by the spec. `bash` requires the sandbox to
  // advertise shell capability — skip it silently otherwise so the
  // agent simply doesn't see the tool (rather than getting unsandboxed
  // exec). Callers who need bash opt in via the sandbox.
  for (const id of wanted) {
    if (id === "bash" && !deps.sandbox.capabilities.shell) continue;
    const t = byId[id as BuiltinToolId];
    if (t) out.push(t);
  }

  // Auto-inject `task` tool when the spec declares subagents and the
  // caller supplied a registry. Spec keeps `subagents` declarative;
  // wiring lives here.
  if (spec.subagents && deps.agentRegistry) {
    const subagentOpts: import("./task-tool.ts").TaskToolOptions = {
      registry: deps.agentRegistry,
      allowedAgents: spec.subagents.allowed,
      ...(spec.subagents.depth !== undefined ? { maxDepth: spec.subagents.depth } : {}),
      ...(spec.subagents.fanOut !== undefined ? { fanOut: spec.subagents.fanOut } : {}),
      deps,
      parentEmit,
    };
    out.push(taskTool(subagentOpts));
  }

  // Auto-inject `skill_load` + `skill_resource` when the spec declares
  // skills + the caller supplied a registry. Allowlist is the spec's
  // declared skill names. Progressive disclosure: names in the system
  // prompt → body via skill_load → supporting files via skill_resource.
  if (spec.skills && spec.skills.length > 0 && deps.skills) {
    out.push(skillLoadTool({ registry: deps.skills, allowed: spec.skills }));
    out.push(skillResourceTool({ registry: deps.skills, allowed: spec.skills }));
  }

  // Auto-inject memory tools when the spec opts in + adapter is wired.
  if (spec.memory?.enabled && deps.memory) {
    out.push(
      rememberTool({
        adapter: deps.memory,
        agentId: spec.id,
        runId,
        emit: parentEmit,
      }),
    );
    out.push(
      recallTool({
        adapter: deps.memory,
        agentId: spec.id,
        runId,
        emit: parentEmit,
      }),
    );
    if (spec.memory.allowForget) {
      out.push(forgetTool({ adapter: deps.memory, agentId: spec.id }));
    }
  }

  // Inject MCP tools from allowed servers. Tool names are already
  // prefixed (`<server>__<tool>`) by the runtime, so collisions across
  // servers are impossible.
  if (spec.mcpServers && spec.mcpServers.length > 0 && deps.mcpRuntime) {
    for (const t of deps.mcpRuntime.tools(spec.mcpServers)) out.push(t);
  }

  // Plugin-contributed tools.
  for (const p of plugins) {
    if (!p.tools) continue;
    for (const t of p.tools) out.push(t);
  }

  // Apply wrapTool decorators in registration order — outermost-last so
  // earlier plugins wrap closer to the underlying execute.
  for (const p of plugins) {
    if (!p.wrapTool) continue;
    out = out.map((t) => p.wrapTool!(t));
  }

  return out;
}

/**
 * An "open" output schema (`Type.Unknown()` / `Type.Any()`) means the agent
 * has no structured-output contract — the system prompt drives the response
 * shape. Only schema-bearing agents get the JSON-output instructions.
 */
function isOpenSchema(schema: TSchema): boolean {
  const k = (schema as unknown as Record<symbol, unknown>)[Kind];
  return k === "Unknown" || k === "Any";
}

function buildUserPrompt(spec: AgentSpec, input: unknown): string {
  const parts = ["Input (JSON):", "```json", JSON.stringify(input, null, 2), "```"];
  if (!isOpenSchema(spec.outputSchema)) {
    parts.push(
      "",
      "Produce output as a JSON object matching this schema:",
      "```json",
      JSON.stringify(spec.outputSchema, null, 2),
      "```",
      "",
      "If you include prose, put the JSON in a final ```json fenced block — the validator reads the last fenced block.",
    );
  }
  return parts.join("\n");
}

function buildSchemaFeedback(message: string): string {
  return `Your previous output did not validate against the agent's outputSchema:\n\n${message}\n\nProduce a corrected output as JSON conforming to the schema. Reply with the JSON only (a fenced \`\`\`json block is fine).`;
}

type Decoded<T> = { ok: true; value: T } | { ok: false; message: string };

function tryDecode<S extends TSchema>(schema: S, text: string): Decoded<unknown> {
  const candidate = extractJson(text);
  if (candidate === null) return { ok: false, message: "no JSON object found in assistant text" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, message: `JSON.parse failed: ${(err as Error).message}` };
  }
  if (!Value.Check(schema, parsed)) {
    const issues = collectIssues(schema, parsed);
    return {
      ok: false,
      message: issues.map((i) => `${i.path}: ${i.message}`).join("; ") || "schema mismatch",
    };
  }
  return { ok: true, value: parsed };
}

function extractJson(text: string): string | null {
  // Prefer the last ```json ... ``` block; otherwise look for a bare object.
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (fenced.length > 0) return fenced[fenced.length - 1]![1]!.trim();
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  // Find the first balanced object.
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function collectIssues(schema: TSchema, value: unknown): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  for (const err of Value.Errors(schema, value)) {
    issues.push({ path: err.path || "$", message: err.message });
    if (issues.length >= 10) break;
  }
  return issues;
}

/**
 * Stable per-spec hash recorded on each `runs` row. Resume compares this
 * against the live spec's hash so an in-place edit of the agent's prompt,
 * tools, schemas, model, retry budget, plugin set, or runtime limits
 * can't silently replay an old transcript under a changed policy.
 *
 * Covers every `AgentSpec` field that affects execution after resume.
 * Plugins are represented by their `id` (function bodies aren't
 * hashable in general) — swapping plugin A for plugin B with the same
 * id is the one drift case this can't detect; bumping the plugin's id
 * when its behaviour changes is the contract.
 *
 * If you need to migrate paused runs across spec versions, write a new
 * `runs` row explicitly rather than mutating the spec.
 */
export function hashSpec(spec: AgentSpec): string {
  let h = 0;
  const s = JSON.stringify({
    id: spec.id,
    tools: spec.tools,
    skills: spec.skills,
    mcpServers: spec.mcpServers,
    commands: spec.commands,
    model: spec.model,
    // For fn-valued prompts, hash `Function.toString()` so source-level
    // edits produce a different hash. Doesn't catch drift via closed-over
    // variables — document that constraint. Prefer string prompts on
    // resumable agents.
    systemPrompt:
      typeof spec.systemPrompt === "string" ? spec.systemPrompt : spec.systemPrompt.toString(),
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    subagents: spec.subagents,
    outputRetries: spec.outputRetries,
    quota: spec.quota ?? null,
    pluginIds: (spec.plugins ?? []).map((p) => p.id),
    memory: spec.memory ?? null,
    instructionFiles: spec.instructionFiles ?? null,
    promptTemplate: spec.promptTemplate ?? null,
    lifecycle: spec.lifecycle ?? null,
  });
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
