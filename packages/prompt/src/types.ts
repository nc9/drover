import type { InstructionFile, MemoryAdapter } from "@droveragent/memory";
import type { SkillRegistry } from "@droveragent/skills";

/**
 * Cache-volatility class of a template segment.
 *
 * - `static`   — identical across runs of the same agent (literal text,
 *                instruction files, skills catalogue, agent id, model).
 *                Survives Anthropic prompt-cache prefix matching.
 * - `volatile` — changes per run or mid-run (`date`, `runId`, the memory
 *                index, dev-supplied `{{ }}` slots). Everything after the
 *                first volatile segment is uncacheable.
 */
export type Volatility = "static" | "volatile";

/**
 * Run-state the harness hands the engine so builtins can resolve. Every
 * field is optional — an absent field makes its builtin render `""`,
 * matching the empty-string discipline of the block renderers.
 *
 * `vars` feeds plain `{{ }}` outputs; `__drover` is a reserved scope key.
 */
export interface PromptScope {
  agent?: { id: string; name?: string };
  run?: { runId: string; cwd: string };
  /** Resolved model id (e.g. for a `{% model %}` footer line). */
  model?: string;
  /** Composed tool ids. */
  tools?: readonly string[];
  /** Instruction files (AGENTS.md / CLAUDE.md), root-first. */
  instructions?: readonly InstructionFile[];
  /** Skill registry + the agent's allowlist. */
  skills?: { registry: SkillRegistry; allowed: readonly string[] };
  /** Memory adapter + the agent id memory is scoped to. */
  memory?: { adapter: MemoryAdapter; agentId: string; maxEntries?: number };
  /**
   * Spawnable subagents — populated only when the spec declares
   * `subagents` and an agent registry is wired. Drives the `{% subagents %}`
   * capability fragment.
   */
  subagents?: {
    allowed: readonly { id: string; description?: string }[];
    maxDepth: number;
    fanOut: number;
  };
  /**
   * Connected MCP servers and their prefixed tool ids — populated when the
   * spec declares `mcpServers` and a runtime is wired. Drives `{% mcp %}`.
   */
  mcp?: { servers: readonly { id: string; tools: readonly string[] }[] };
  /** Execution environment — sandbox id (cwd/model already live on `run`/`model`). */
  environment?: { sandboxId: string };
  /** Dev-supplied values for `{{ }}` output slots. */
  vars?: Readonly<Record<string, string | number | boolean>>;
}

/** One cache-ordering note from the analyzer. */
export interface CacheWarning {
  message: string;
  /** 1-based source line of the offending directive, when known. */
  line?: number;
  /** Builtin tag name, when the offender is a builtin (not a `{{ }}` slot). */
  builtin?: string;
}

/**
 * Compile-time prompt-cache assessment. `cacheablePrefixChars` is the
 * length of the leading static run — the portion Anthropic can match as
 * a cached prefix before the first volatile segment breaks it.
 */
export interface CacheReport {
  cacheablePrefixChars: number;
  totalChars: number;
  warnings: ReadonlyArray<CacheWarning>;
  /** True when `autoReorder` moved volatile builtins to a footer. */
  reordered: boolean;
}

export interface RenderResult {
  text: string;
  cache: CacheReport;
}

export interface RenderOpts {
  /**
   * Move volatile builtin tags (`date`, `time`, `memory`, `runId`) to a
   * footer so the static prefix is contiguous and cacheable. Off by
   * default — it changes where those directives appear in the prompt.
   */
  autoReorder?: boolean;
}

/** A drover builtin — registered as a custom Liquid tag. */
export interface Builtin {
  name: string;
  volatility: Volatility;
  render(scope: PromptScope, hash: Readonly<Record<string, unknown>>): string | Promise<string>;
}

export interface PromptEngine {
  /** Render a template string against run state. */
  render(template: string, scope: PromptScope, opts?: RenderOpts): Promise<RenderResult>;
  /** Read a `.md.liquid` (or `.md`) file, then `render`. */
  renderFile(path: string, scope: PromptScope, opts?: RenderOpts): Promise<RenderResult>;
  /** Compile-time cache assessment — no run state needed. */
  analyze(template: string): CacheReport;
}
