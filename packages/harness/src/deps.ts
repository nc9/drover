import type { CommandRegistry } from "@drover/commands";
import type { McpRuntime } from "@drover/mcp";
import type { ResolveOptions } from "@drover/model";
import type { SandboxAdapter } from "@drover/sandbox";
import type { MemoryAdapter } from "@drover/memory";
import type { SkillRegistry } from "@drover/skills";
import type { StorageAdapter } from "@drover/storage";

/**
 * Per-run dependencies the harness needs. Extracted into its own module so
 * `capability-gates.ts` can import it without a runtime cycle through
 * `run.ts`. Re-exported from `run.ts` for back-compat.
 */
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
