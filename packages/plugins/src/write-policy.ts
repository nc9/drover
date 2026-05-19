import type { HarnessPlugin } from "@drover/core";
import { Effect } from "effect";
import * as path from "node:path";

export interface WritePolicyOptions {
  /**
   * Absolute paths the agent is permitted to write under. Anything
   * outside (any ancestor escape, including via `..`) is denied at the
   * tool-input stage before the sandbox check runs. Use this as an
   * additional layer beyond `SandboxAdapter.allowedRoots` for narrower
   * write perimeters (e.g. allow read of the whole repo, restrict write
   * to a single subtree).
   */
  scopedWritePaths: ReadonlyArray<string>;
  /**
   * Tool ids gated by this policy. Defaults to `["write", "edit"]` —
   * the canonical filesystem-mutating tools. Add custom ids if your
   * project ships its own write tools.
   */
  toolIds?: ReadonlyArray<string>;
}

/**
 * Path-scoped write gate. The sandbox confines reads/exec to the run's
 * working tree; `writePolicyPlugin` narrows writes to a specific subset
 * of that tree.
 *
 * The check is on the tool's `path` input — does NOT follow symlinks
 * (that's the sandbox layer's job; both layers should be wired
 * together for a tight perimeter). Denies map to a `deny` decision
 * with a corrective message the model can act on.
 */
export function writePolicyPlugin(opts: WritePolicyOptions): HarnessPlugin {
  const scoped = opts.scopedWritePaths.map((p) => path.resolve(p));
  const toolFilter = new Set(opts.toolIds ?? ["write", "edit"]);

  return {
    id: "write-policy",
    beforeToolCall: (toolName, input) =>
      Effect.sync(() => {
        if (!toolFilter.has(toolName)) return { kind: "allow" as const };
        const obj = input as { path?: unknown };
        const p = typeof obj?.path === "string" ? obj.path : null;
        if (!p) return { kind: "allow" as const };
        const abs = path.resolve(p);
        const ok = scoped.some(
          (root) => abs === root || abs.startsWith(root + path.sep),
        );
        if (ok) return { kind: "allow" as const };
        return {
          kind: "deny" as const,
          reason: `write-policy: ${abs} is outside the agent's permitted write paths [${scoped.join(", ")}]. Use a path under one of those, or report the constraint and stop.`,
        };
      }),
  };
}
