import type { AgentSpec } from "@droveragent/core";

import type { HarnessDeps } from "./deps.ts";

/**
 * Per-mechanism activation predicates. A mechanism is "active" when the
 * spec opts in AND the matching dependency is wired — the exact condition
 * under which the harness auto-injects both the mechanism's tool(s) and its
 * capability prompt fragment. Shared by `composeTools` and
 * `buildPromptScope` so the tool and the fragment can never disagree.
 *
 * Note: the memory *index* fragment additionally honours
 * `spec.memory.includeIndex !== false` — that's a display-only toggle
 * applied at the fragment site, not part of "mechanism active".
 */

/** True when the `task` tool + `subagents` fragment should be injected. */
export const subagentsActive = (spec: AgentSpec, deps: HarnessDeps): boolean =>
  spec.subagents !== undefined && deps.agentRegistry !== undefined;

/** True when `skill_load` / `skill_resource` + `skills` fragment should be injected. */
export const skillsActive = (spec: AgentSpec, deps: HarnessDeps): boolean =>
  spec.skills !== undefined && spec.skills.length > 0 && deps.skills !== undefined;

/** True when `remember` / `recall` + `memory` fragment should be injected. */
export const memoryActive = (spec: AgentSpec, deps: HarnessDeps): boolean =>
  spec.memory?.enabled === true && deps.memory !== undefined;

/** True when MCP tools + `mcp` fragment should be injected. */
export const mcpActive = (spec: AgentSpec, deps: HarnessDeps): boolean =>
  spec.mcpServers !== undefined && spec.mcpServers.length > 0 && deps.mcpRuntime !== undefined;
