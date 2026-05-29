import { Type } from "@sinclair/typebox";
import { defineTool, type ToolDef, type ToolResult } from "@droveragent/core";
import { Effect } from "effect";

import { listSkillResources, readSkillResource } from "./loader.ts";
import type { SkillRegistry } from "./registry.ts";

const InputSchema = Type.Object({
  name: Type.String({ description: "Skill name (must be allowlisted)." }),
  resource: Type.Optional(
    Type.String({
      description:
        "Relative path under the skill directory (e.g. 'references/REFERENCE.md', 'scripts/extract.py'). Omit to list available resources instead of reading one.",
    }),
  ),
});

export interface SkillResourceOptions {
  registry: SkillRegistry;
  /** Allowlist of skill names — must match what `skill_load` uses. */
  allowed: ReadonlyArray<string>;
  /**
   * Max bytes to return per read. Larger files return a truncation
   * notice instead of partial content (no chunking in v0).
   */
  maxBytes?: number;
}

/**
 * Builder for the `skill_resource` tool — the on-demand half of
 * progressive disclosure. After `skill_load` returns the body, the
 * model can call this to fetch supporting files (scripts, references,
 * assets) one at a time.
 *
 * Path safety: refuses absolute paths and any `..` escapes.
 */
export function skillResourceTool(opts: SkillResourceOptions): ToolDef<typeof InputSchema> {
  const allowed = new Set(opts.allowed);
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  return defineTool({
    id: "skill_resource",
    description:
      "Read or list supporting files in a skill directory. Call without `resource` to list available files, with `resource` to read one. Use after `skill_load` if the skill body references additional files.",
    inputSchema: InputSchema,
    execute: (input): Effect.Effect<ToolResult, never, never> =>
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
            content: `skill '${input.name}' is allowed but not registered.`,
            isError: true,
            data: { skill: input.name, reason: "missing" },
          };
        }
        if (!input.resource) {
          const res = await listSkillResources(skill);
          const lines: string[] = [];
          const section = (label: string, items: ReadonlyArray<string>): void => {
            if (items.length === 0) return;
            lines.push(`## ${label}`);
            for (const it of items) lines.push(`- ${label.toLowerCase()}/${it}`);
            lines.push("");
          };
          section("scripts", res.scripts);
          section("references", res.references);
          section("assets", res.assets);
          if (res.other.length > 0) {
            lines.push("## other");
            for (const it of res.other) lines.push(`- ${it}`);
          }
          if (lines.length === 0) lines.push("(no supporting files)");
          return {
            content: lines.join("\n"),
            data: { skill: skill.name, resources: res },
          };
        }
        try {
          const text = await readSkillResource(skill, input.resource);
          if (Buffer.byteLength(text, "utf8") > maxBytes) {
            return {
              content: `resource '${input.resource}' exceeds ${maxBytes} bytes — refusing to inline. Read it directly via a file tool if appropriate.`,
              isError: true,
              data: { skill: skill.name, resource: input.resource, reason: "too_large" },
            };
          }
          return {
            content: text,
            data: { skill: skill.name, resource: input.resource },
          };
        } catch (err) {
          return {
            content: `cannot read '${input.resource}': ${(err as Error).message}`,
            isError: true,
            data: { skill: skill.name, resource: input.resource, reason: "read_failed" },
          };
        }
      }),
  });
}
