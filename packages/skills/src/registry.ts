import type { SkillSpec } from "./loader.ts";

/**
 * In-process directory of available skills. Built once at boot from a
 * `scanSkillDirs(...)` result; passed to the harness via `HarnessDeps.skills`.
 *
 * Per-agent filtering happens at the harness layer using `spec.skills`
 * (allowlist). The registry itself doesn't enforce policy.
 */
export interface SkillRegistry {
  get(name: string): SkillSpec | undefined;
  list(): ReadonlyArray<SkillSpec>;
  has(name: string): boolean;
}

export function createSkillRegistry(skills: ReadonlyArray<SkillSpec>): SkillRegistry {
  // First-wins dedup, matching `scanSkillDirs`. Pass agent-local skill
  // dirs ahead of shared ones so local skills shadow library skills.
  const byName = new Map<string, SkillSpec>();
  for (const s of skills) {
    if (!byName.has(s.name)) byName.set(s.name, s);
  }
  const all = [...byName.values()];
  return {
    get: (name) => byName.get(name),
    has: (name) => byName.has(name),
    list: () => all,
  };
}
