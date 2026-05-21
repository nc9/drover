import type { CommandSpec } from "./loader.ts";

/**
 * In-process directory of available commands. Built once at boot from a
 * `scanCommandDirs(...)` result; passed to the harness via
 * `HarnessDeps.commands`.
 *
 * Per-agent filtering happens at the harness layer using `spec.commands`
 * (allowlist). The registry itself doesn't enforce policy.
 */
export interface CommandRegistry {
  get(name: string): CommandSpec | undefined;
  list(): ReadonlyArray<CommandSpec>;
  has(name: string): boolean;
}

export function createCommandRegistry(commands: ReadonlyArray<CommandSpec>): CommandRegistry {
  // First-wins dedup, matching `scanCommandDirs`. Pass agent-local
  // command dirs ahead of shared ones so local commands shadow library ones.
  const byName = new Map<string, CommandSpec>();
  for (const c of commands) {
    if (!byName.has(c.name)) byName.set(c.name, c);
  }
  const all = [...byName.values()];
  return {
    get: (name) => byName.get(name),
    has: (name) => byName.has(name),
    list: () => all,
  };
}
