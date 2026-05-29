import type { TSchema, Static } from "@sinclair/typebox";

import type { RunContext } from "./context.ts";
import type { HarnessPlugin } from "./plugin.ts";

/**
 * Reasoning level for models that expose extended thinking.
 * Maps 1:1 onto pi-ai's reasoning gates.
 */
export type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Anthropic prompt-cache retention. Maps 1:1 onto pi-ai's
 * `cacheRetention` stream option — `none` disables caching, `short`/`long`
 * select the breakpoint TTL. Drover cannot place a mid-prompt breakpoint
 * (pi sends the system prompt as one block), so the cache hit depends on
 * a byte-stable prefix — see `@droveragent/prompt`'s cache analyzer.
 */
export type CacheRetention = "none" | "short" | "long";

/**
 * Model spec. Three accepted forms:
 *   - "sonnet"            — bare name (alias or pi-ai builtin)
 *   - "sonnet:high"       — name with reasoning suffix
 *   - { name, reasoning?, temperature?, maxTokens?, cacheRetention? }
 *
 * Resolution lookup: aliases ∪ pi-ai builtin names. Aliases shadow builtins.
 */
export type ModelSpec =
  | string
  | {
      name: string;
      reasoning?: ReasoningLevel;
      temperature?: number;
      maxTokens?: number;
      /** Prompt-cache retention. Default: pi-ai's default (no caching). */
      cacheRetention?: CacheRetention;
    };

/** Memory configuration — gates `remember`/`recall`/`forget` and the index block. */
export interface MemorySpec {
  /** Master switch — wire memory tools and index block when true. */
  enabled: boolean;
  /** Auto-inject the scoped summary index in the system prompt. Default true. */
  includeIndex?: boolean;
  /** Max entries surfaced in the auto-injected index. Default 30. */
  maxIndexEntries?: number;
  /** Expose `forget` to the agent. Off by default (irreversible). */
  allowForget?: boolean;
  /** Cap on `remember` calls per turn. Default 1. Set 0 to disable rate-limit. */
  writesPerTurn?: number;
}

/**
 * Instruction-file loading config — discovers `AGENTS.md` / `CLAUDE.md`
 * (or any configured filenames) along the ancestor chain from the repo
 * root down to the run's `cwd`. Fully opt-in; absent = no scanning.
 */
export interface InstructionFilesConfig {
  /** Filenames to match, in precedence order. Default `["AGENTS.md", "CLAUDE.md"]`. */
  filenames?: readonly string[];
  /** Top of the ancestor chain. Default: nearest `.git` ancestor of cwd, else cwd. */
  root?: string;
  /** Per-file byte cap; larger files are truncated with a notice. Default 16384. */
  maxBytesPerFile?: number;
  /** Also seed loaded files into the memory adapter as recall-able entries. Default true. */
  seedMemory?: boolean;
}

/**
 * Prompt-template config — opt in to assembling the system prompt from a
 * `.md.liquid` template (via `@droveragent/prompt`) instead of the harness's
 * default block join. The template renders drover builtins (`{% memory %}`,
 * `{% skills %}`, `{% instructions %}`, …) from run state. When active,
 * `spec.systemPrompt` is not used for assembly — the template owns layout.
 *
 * Provide one of `source` or `path`. A config with neither is ignored —
 * assembly falls back to the default `systemPrompt` + block join.
 */
export interface PromptTemplateConfig {
  /** Inline template source. Takes precedence over `path`. */
  source?: string;
  /** Path to a `.md.liquid` template; relative paths resolve against the run cwd. */
  path?: string;
  /** Move volatile builtins to a cacheable footer. Default false. */
  autoReorder?: boolean;
}

/** Subagent capacity limits enforced by the `taskTool` factory. */
export interface SubagentConfig {
  /** Maximum nesting depth from the root run. Default 2. */
  depth?: number;
  /** Max concurrent child agents per parent. Default 3. */
  fanOut?: number;
  /** Allowlist of agent ids the parent may spawn. Empty = none. */
  allowed: readonly string[];
}

/**
 * System prompt may be a string or a function of the run context — agents
 * that need to interpolate run-scoped values resolve at run-start.
 */
export type SystemPromptFn = (ctx: RunContext) => string | Promise<string>;

/**
 * One deterministic step in an agent's `lifecycle`. Each step resolves to a
 * text block: `init` blocks prepend to the opening user turn; `postSuccess`
 * blocks are appended as a closing turn the agent acts on after its natural
 * end. A tagged union so the whole `lifecycle` stays JSON-serialisable.
 */
export type LifecycleStep =
  /** Render a command (markdown prompt macro) with `args`. */
  | { kind: "command"; name: string; args?: Record<string, unknown> }
  /** Pre-expand a skill's body into context (no `skill_load` round-trip). */
  | { kind: "skill"; name: string }
  /** Call an MCP tool host-side and inject its result. `tool` is prefixed. */
  | { kind: "mcp"; tool: string; args?: Record<string, unknown> }
  /** A literal text block. */
  | { kind: "prompt"; text: string };

/**
 * Deterministic, host-controlled lifecycle around the agent loop.
 * `init` runs before the loop (priming context); `postSuccess` runs after
 * the agent's natural completion, on a `success` terminal status only —
 * hence the explicit name (it is *not* an unconditional `finally`).
 */
export interface LifecycleConfig {
  /** Steps composed into the opening user turn, before the run input. */
  init?: readonly LifecycleStep[];
  /**
   * Steps appended as a closing turn after a successful natural end. Runs
   * only when the run's terminal status is `success` — skipped on
   * `error` / `quota` / `cancelled` / `paused`.
   */
  postSuccess?: readonly LifecycleStep[];
}

/**
 * Resource budget for a whole run. Every dimension is enforced through the
 * same abort path — a breach stops the loop and yields terminal status
 * `quota` (see {@link QuotaExceededError}). Omit a field to leave that
 * dimension unbounded.
 */
export interface RunQuota {
  /** Hard turn budget. The loop is aborted once this many turns complete. Unbounded when omitted. */
  maxTurns?: number;
  /** Wall-clock budget (ms) for the whole run — `init` + loop + `postSuccess`. */
  maxDurationMs?: number;
  /** Cumulative USD ceiling, checked after each model response. */
  maxCostUsd?: number;
}

/**
 * The data substrate. JSON-serialisable when `systemPrompt` is a string.
 * Dynamic agents (LLM-composed at runtime) build the same shape.
 *
 * Generic params `I`/`O` carry static input/output types inferred from
 * TypeBox schemas — use `defineAgent` to get inference automatically.
 */
export interface AgentSpec<ISchema extends TSchema = TSchema, OSchema extends TSchema = TSchema> {
  id: string;
  /**
   * Human-readable role summary. Optional. Surfaced in a parent agent's
   * `subagents` capability fragment (one line per spawnable agent) so the
   * model can pick a sensible `agent_type` for the `task` tool. Folded into
   * `hashSpec`, so editing it invalidates resumed runs.
   */
  description?: string;
  systemPrompt: string | SystemPromptFn;
  inputSchema: ISchema;
  outputSchema: OSchema;
  model: ModelSpec;
  /** Built-in `ToolDef` ids and MCP-prefixed tool ids the agent may invoke. */
  tools: readonly string[];
  /** SKILL.md ids reachable via the `skill_load` tool. */
  skills?: readonly string[];
  /** MCP server ids whose tools are merged into the toolset. */
  mcpServers?: readonly string[];
  /** Command ids the agent's `lifecycle` steps may invoke (allowlist). */
  commands?: readonly string[];
  /**
   * Deterministic, host-controlled steps run before (`init`) and after
   * (`postSuccess`) the agent loop. See {@link LifecycleConfig}.
   */
  lifecycle?: LifecycleConfig;
  /** Subagent configuration; omit to forbid spawning entirely. */
  subagents?: SubagentConfig;
  /** Output-schema self-correction retry budget. Default 2. */
  outputRetries?: number;
  /** Plugin bundles (hooks + tools + observers) attached to this agent. */
  plugins?: readonly HarnessPlugin[];
  /** Resource budget — turns, wall-clock, cost. See {@link RunQuota}. */
  quota?: RunQuota;
  /** Self-curated knowledge across runs. Wires `remember`/`recall` tools. */
  memory?: MemorySpec;
  /**
   * Ambient project instructions (`AGENTS.md` / `CLAUDE.md`). When set,
   * the harness loads the ancestor chain into the system prompt and —
   * when a memory adapter is wired — seeds them as recall-able entries.
   */
  instructionFiles?: InstructionFilesConfig;
  /**
   * Compose the system prompt from a Liquid template instead of the
   * default block join. When set, the template fully defines the prompt.
   */
  promptTemplate?: PromptTemplateConfig;
}

/** Static input type derived from an `AgentSpec`'s `inputSchema`. */
export type AgentInput<S extends AgentSpec> = Static<S["inputSchema"]>;
/** Static output type derived from an `AgentSpec`'s `outputSchema`. */
export type AgentOutput<S extends AgentSpec> = Static<S["outputSchema"]>;

/**
 * Identity builder. Exists so consumers get TypeScript inference on
 * `Static<S["inputSchema"]>` / `Static<S["outputSchema"]>` without
 * having to thread generics through call sites.
 *
 * No runtime work — the harness consumes the returned spec directly.
 */
export function defineAgent<ISchema extends TSchema, OSchema extends TSchema>(
  spec: AgentSpec<ISchema, OSchema>,
): AgentSpec<ISchema, OSchema> {
  return spec;
}
