import { Type } from "@sinclair/typebox";
import {
  defineTool,
  type ToolDef,
  type ToolResult,
} from "@drover/core";
import { Effect } from "effect";

import { listSkillResources } from "./loader.ts";
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
  /**
   * When true (default), the response body is suffixed with a one-line
   * pointer to `skill_resource` if the skill ships scripts/references/
   * assets. Off if you wire `skill_resource` separately or skip resources.
   */
  hintResources?: boolean;
}

/**
 * Builder for the `skill_load` tool — the activation half of progressive
 * disclosure. The system prompt advertises name + description (cheap);
 * only when the model decides it needs full instructions does it call
 * this tool. Skills outside `allowed` are denied so progressive
 * disclosure can't bypass least-privilege intent.
 *
 * When the skill has supporting files in `scripts/`, `references/`, or
 * `assets/`, the response body is suffixed with a pointer to the
 * `skill_resource` tool so the model can pull them on demand.
 */
export function skillLoadTool(opts: SkillLoadOptions): ToolDef<typeof InputSchema> {
  const allowed = new Set(opts.allowed);
  const hintResources = opts.hintResources ?? true;
  return defineTool({
    id: "skill_load",
    description:
      "Load the full instructions for a named skill. Use after the system prompt advertises a skill's name and description.",
    inputSchema: InputSchema,
    execute: (input, ctx): Effect.Effect<ToolResult, never, never> =>
      Effect.promise(async (): Promise<ToolResult> => {
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
        let content = skill.body;
        let resources: Awaited<ReturnType<typeof listSkillResources>> | undefined;
        if (hintResources) {
          resources = await listSkillResources(skill);
          const counts = [
            resources.scripts.length > 0 ? `${resources.scripts.length} script(s)` : null,
            resources.references.length > 0 ? `${resources.references.length} reference(s)` : null,
            resources.assets.length > 0 ? `${resources.assets.length} asset(s)` : null,
          ].filter((s): s is string => s !== null);
          if (counts.length > 0) {
            content += `\n\n---\nThis skill ships ${counts.join(", ")}. Call \`skill_resource(name="${skill.name}")\` to list, or \`skill_resource(name="${skill.name}", resource="<relative-path>")\` to read one.`;
          }
        }
        return {
          content,
          data: {
            skill: skill.name,
            path: skill.path,
            ...(resources ? { resources } : {}),
          },
        };
      }),
  });
}
