import { LifecycleError, type LifecycleStep } from "@drover/core";
import { type CommandRegistry, renderCommand } from "@drover/commands";
import type { McpRuntime } from "@drover/mcp";
import type { PromptEngine, PromptScope } from "@drover/prompt";
import type { SkillRegistry } from "@drover/skills";

/** Registries a lifecycle step may resolve against. */
export interface LifecycleStepDeps {
  commands?: CommandRegistry;
  skills?: SkillRegistry;
  mcpRuntime?: McpRuntime;
}

export interface RunLifecycleArgs {
  phase: "init" | "postSuccess";
  steps: readonly LifecycleStep[];
  runId: string;
  /** `spec.commands` — allowlist for `command` steps. */
  allowedCommands: readonly string[];
  /** `spec.skills` — allowlist for `skill` steps. */
  allowedSkills: readonly string[];
  /** `spec.mcpServers` — allowlist for `mcp` steps (matched on server id). */
  allowedMcpServers: readonly string[];
  deps: LifecycleStepDeps;
  engine: PromptEngine;
  scope: PromptScope;
}

/**
 * Resolve a deterministic lifecycle (`init` / `postSuccess`) to an ordered
 * list of text blocks. Each block is injected as part of a conversation turn.
 * Throws {@link LifecycleError} on any misconfiguration — a missing or
 * disallowed command/skill, or a failed MCP call — so a broken lifecycle
 * fails the run loudly rather than silently dropping a step.
 */
export async function runLifecycleSteps(args: RunLifecycleArgs): Promise<string[]> {
  const blocks: string[] = [];
  for (const step of args.steps) {
    blocks.push(await resolveStep(step, args));
  }
  return blocks;
}

async function resolveStep(step: LifecycleStep, args: RunLifecycleArgs): Promise<string> {
  const { phase, runId, deps } = args;
  const fail = (stepLabel: string, message: string): LifecycleError =>
    new LifecycleError({ runId, phase, step: stepLabel, message });

  switch (step.kind) {
    case "prompt":
      return step.text;

    case "command": {
      const label = `command:${step.name}`;
      if (!args.allowedCommands.includes(step.name)) {
        throw fail(label, "command is not in the agent's `commands` allowlist");
      }
      if (!deps.commands) throw fail(label, "no command registry wired into the run");
      const cmd = deps.commands.get(step.name);
      if (!cmd) throw fail(label, "command not found in the registry");
      return renderCommand(cmd, {
        engine: args.engine,
        scope: args.scope,
        ...(step.args ? { args: step.args } : {}),
      });
    }

    case "skill": {
      const label = `skill:${step.name}`;
      if (!args.allowedSkills.includes(step.name)) {
        throw fail(label, "skill is not in the agent's `skills` allowlist");
      }
      if (!deps.skills) throw fail(label, "no skill registry wired into the run");
      const skill = deps.skills.get(step.name);
      if (!skill) throw fail(label, "skill not found in the registry");
      return `## Skill: ${skill.name}\n\n${skill.body}`;
    }

    case "mcp": {
      const label = `mcp:${step.tool}`;
      if (!deps.mcpRuntime) throw fail(label, "no MCP runtime wired into the run");
      const sep = step.tool.indexOf("__");
      const serverId = sep > 0 ? step.tool.slice(0, sep) : step.tool;
      if (!args.allowedMcpServers.includes(serverId)) {
        throw fail(label, `server '${serverId}' is not in the agent's \`mcpServers\` allowlist`);
      }
      try {
        const result = await deps.mcpRuntime.callTool(step.tool, step.args ?? {});
        return `## ${step.tool}\n\n${result}`;
      } catch (err) {
        throw fail(label, `MCP call failed: ${(err as Error).message}`);
      }
    }
  }
}
