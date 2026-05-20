import {
  type AgentInput,
  type AgentOutput,
  type AgentSpec,
  type AnyToolDef,
  CancelledError,
  type HarnessError,
  type HarnessEvent,
  InputValidationError,
  MaxTurnsError,
  OutputValidationError,
  type RunContext,
  type RunResult,
  type RunStatus,
  type ToolExecutionContext,
  type Usage,
} from "@drover/core";
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
import type { AgentLoopConfig, AgentMessage } from "@mariozechner/pi-agent-core";
import type { KnownApi, Message, UserMessage } from "@mariozechner/pi-ai";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
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

const DEFAULT_MAX_TURNS = 30;
const DEFAULT_OUTPUT_RETRIES = 2;

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

    const userPrompt = buildUserPrompt(spec, input);

    // Convert tools to pi shape.
    const buildToolCtx = (toolCallId: string, signal?: AbortSignal): ToolExecutionContext & {
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
    const maxTurns = spec.maxTurns ?? DEFAULT_MAX_TURNS;

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
        const u = (e.message as { usage?: { input?: number; output?: number; cost?: { total?: number } } })?.usage;
        if (u) {
          const next: Usage = {
            inputTokens: (lastUsage.value.inputTokens ?? 0) + (u.input ?? 0),
            outputTokens: (lastUsage.value.outputTokens ?? 0) + (u.output ?? 0),
          };
          const cost = (lastUsage.value.costUsd ?? 0) + (u.cost?.total ?? 0);
          if (cost > 0) next.costUsd = cost;
          lastUsage.value = next;
        }
      }
      // Emit translated drover events. safeEmit fans out to plugin observers.
      for (const ev of translator.translate(e)) safeEmit(ev);
      // Persist checkpoint at the end of every turn — covers tool-using runs
      // (turn_end fires after each tool batch) and pure-text runs.
      if (e.type === "turn_end") {
        persistCheckpoint(translator.currentTurn(), Date.now());
      }
    };

    // Output-schema self-correction.
    const getFollowUpMessages = async (): Promise<UserMessage[]> => {
      if (ctx.signal.aborted) return [];
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
      ? async (
          pCtx: { toolCall: { name: string }; args: unknown },
        ): Promise<{ block?: boolean; reason?: string }> => {
          for (const p of plugins) {
            if (!p.beforeToolCall) continue;
            const decision = await Effect.runPromise(
              Effect.either(p.beforeToolCall(pCtx.toolCall.name, pCtx.args, ctx)),
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
      ? async (
          aCtx: { toolCall: { name: string }; args: unknown; result: { content: Array<{ type: string; text?: string }>; details?: unknown }; isError: boolean },
        ): Promise<{ content?: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean }> => {
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
          const out: { content?: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean } = {
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
      content: userPrompt,
      timestamp: Date.now(),
    };

    // Wall-clock timeout + abort handling.
    const abortController = new AbortController();
    const onParentAbort = (): void => abortController.abort();
    if (ctx.signal.aborted) abortController.abort();
    else ctx.signal.addEventListener("abort", onParentAbort, { once: true });
    const timeoutHandle = spec.timeoutMs
      ? setTimeout(() => abortController.abort(), spec.timeoutMs)
      : undefined;

    // Treat the pi loop's rejection as a recoverable signal — the post-loop
    // section is responsible for choosing the final status (paused vs
    // cancelled vs error). Without this, an abort-mid-flight would short-
    // circuit before storage gets the "paused" mark.
    let loopError: Error | null = null;
    try {
      yield* Effect.promise(async (): Promise<void> => {
        try {
          if (isResume) {
            await runAgentLoopContinue(
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
            await runAgentLoop(
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
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      ctx.signal.removeEventListener("abort", onParentAbort);
    }

    // Aggregate usage.
    usage.inputTokens = lastUsage.value.inputTokens;
    usage.outputTokens = lastUsage.value.outputTokens;
    if (lastUsage.value.costUsd !== undefined) usage.costUsd = lastUsage.value.costUsd;

    // Resolve terminal status. Priority order:
    //   1. pauseFlag → paused (resumable later via resumeAgent)
    //   2. external cancellation → cancelled
    //   3. loop threw → error
    //   4. no final text + turn cap → max_turns
    //   5. no final text → error
    //   6. final text decodes → success
    //   7. final text fails schema → error
    let output: AgentOutput<S> | undefined;
    let status: RunStatus = "success";
    let errorOut: { tag: string; message: string } | undefined;

    const finalText = lastAssistant.text;

    if (pauseFlag?.requested) {
      status = "paused";
    } else if (abortController.signal.aborted && ctx.signal.aborted) {
      status = "cancelled";
      errorOut = { tag: "CancelledError", message: "cancelled by caller" };
    } else if (loopError) {
      status = "error";
      errorOut = { tag: "LoopError", message: (loopError as Error).message };
    } else if (!finalText || finalText.trim().length === 0) {
      const turnCap = translator.currentTurn() >= maxTurns;
      if (turnCap) {
        status = "max_turns";
        errorOut = { tag: "MaxTurnsError", message: `reached ${maxTurns} turns without output` };
      } else {
        status = "error";
        errorOut = { tag: "OutputValidationError", message: "no final assistant text" };
      }
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

    // Success at the turn cap is still success — the cap is a budget,
    // not a tripwire on the happy path. Only convert no-output runs at
    // the cap into MaxTurnsError (that path was handled above).
    const turns = translator.currentTurn();
    if (status === "max_turns" && !errorOut) {
      return yield* Effect.fail(new MaxTurnsError({ runId: ctx.runId, maxTurns }));
    }

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

function buildUserPrompt(spec: AgentSpec, input: unknown): string {
  return [
    "Input (JSON):",
    "```json",
    JSON.stringify(input, null, 2),
    "```",
    "",
    "Your output MUST be a JSON object matching this schema:",
    "```json",
    JSON.stringify(spec.outputSchema, null, 2),
    "```",
    "",
    "Reply with the JSON object only. If you must include prose, wrap the JSON in a ```json fenced block at the end of your message; the validator extracts the last fenced JSON. Do NOT echo the input.",
  ].join("\n");
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
    model: spec.model,
    // For fn-valued prompts, hash `Function.toString()` so source-level
    // edits produce a different hash. Doesn't catch drift via closed-over
    // variables — document that constraint. Prefer string prompts on
    // resumable agents.
    systemPrompt:
      typeof spec.systemPrompt === "string"
        ? spec.systemPrompt
        : spec.systemPrompt.toString(),
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    subagents: spec.subagents,
    outputRetries: spec.outputRetries,
    maxTurns: spec.maxTurns,
    timeoutMs: spec.timeoutMs,
    pluginIds: (spec.plugins ?? []).map((p) => p.id),
    memory: spec.memory ?? null,
    instructionFiles: spec.instructionFiles ?? null,
    promptTemplate: spec.promptTemplate ?? null,
  });
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
