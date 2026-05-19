import { Type } from "@sinclair/typebox";
import {
  defineTool,
  SandboxError,
  type ToolDef,
  type ToolResult,
} from "@drover/core";
import { Effect } from "effect";

import type { SkillRegistry } from "./registry.ts";

const InputSchema = Type.Object({
  name: Type.String({ description: "Skill name (as advertised in the system prompt)." }),
});

export interface SkillLoadOptions {
  registry: SkillRegistry;
  /**
   * Allowlist of skill names this agent may load. Names outside it return
   * a deny result so the model can recover without crashing the run.
   * Empty array = no skills available.
   */
  allowed: ReadonlyArray<string>;
}

/**
 * Builder for the `skill_load` tool. Progressive disclosure: the system
 * prompt advertises name + description (cheap), and only when the model
 * decides it needs the full instructions does it call this tool. Skills
 * outside `allowed` are denied so progressive disclosure can't bypass
 * least-privilege intent.
 */
export function skillLoadTool(opts: SkillLoadOptions): ToolDef<typeof InputSchema> {
  const allowed = new Set(opts.allowed);
  return defineTool({
    id: "skill_load",
    description:
      "Load the full instructions for a named skill. Use after the system prompt advertises a skill's name and description.",
    inputSchema: InputSchema,
    execute: (input, ctx): Effect.Effect<ToolResult, SandboxError, never> =>
      Effect.sync((): ToolResult => {
        if (!allowed.has(input.name)) {
          return {
            content: `skill '${input.name}' is not available to this agent. allowed: [${[...allowed].join(", ") || "(none)"}]`,
            isError: true,
            data: { skill: input.name, reason: "not_allowed" },
          };
        }
        const skill = opts.registry.get(input.name);
        if (!skill) {
          return {
            content: `skill '${input.name}' is allowed but not registered — check that the skill directory contains a SKILL.md.`,
            isError: true,
            data: { skill: input.name, reason: "missing", runId: ctx.runId },
          };
        }
        return {
          content: skill.body,
          data: { skill: skill.name, path: skill.path },
        };
      }),
  });
}
