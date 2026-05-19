import type { SkillRegistry } from "./registry.ts";

/**
 * Build the "Available skills" suffix appended to the agent's system prompt
 * when skills are wired. Only advertises names the agent is allowed to load;
 * the body is fetched lazily via `skill_load`.
 *
 * Returns an empty string when no skills are reachable — callers can append
 * blindly without a guard.
 */
export function renderSkillsBlock(
  registry: SkillRegistry,
  allowed: ReadonlyArray<string>,
): string {
  if (allowed.length === 0) return "";
  const lines: string[] = [];
  for (const name of allowed) {
    const skill = registry.get(name);
    if (!skill) continue;
    // One-line description preview — keep the block under ~1KB even when
    // long-form descriptions are written across multiple lines.
    const summary = skill.description.replace(/\s+/g, " ").trim().slice(0, 200);
    lines.push(`- ${name}: ${summary}`);
    if (skill.compatibility) {
      lines.push(`  (compatibility: ${skill.compatibility})`);
    }
  }
  if (lines.length === 0) return "";
  return [
    "",
    "## Available skills",
    "",
    "Call `skill_load(name=\"<name>\")` to load full instructions for one of these:",
    "",
    ...lines,
  ].join("\n");
}
