import type { PromptEngine, PromptScope } from "@drover/prompt";
import type { CommandSpec } from "./loader.ts";

export interface RenderCommandOptions {
  /** The prompt engine — a command body is a Liquid template. */
  engine: PromptEngine;
  /** Run-state scope for builtins (`{% skills %}`, `{% cwd %}`, …). */
  scope?: PromptScope;
  /** Caller-supplied arguments, bound into `{{ }}` slots via `scope.vars`. */
  args?: Record<string, unknown>;
}

/**
 * Coerce arbitrary `args` to the `string | number | boolean` shape the
 * prompt engine's `vars` accepts. Scalars pass through; everything else
 * is JSON-encoded so a `{{ obj }}` slot still renders something useful.
 */
function coerceArgs(
  args: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!args) return out;
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (v === null || v === undefined) {
      continue;
    } else {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}

/**
 * Render a command to the text injected as a conversation turn. The
 * command body is a Liquid template; `args` are merged over `scope.vars`
 * so a command can interpolate caller arguments (`{{ issue }}`) and use
 * prompt builtins (`{% cwd %}`).
 */
export async function renderCommand(
  spec: CommandSpec,
  opts: RenderCommandOptions,
): Promise<string> {
  const vars = { ...opts.scope?.vars, ...coerceArgs(opts.args) };
  const scope: PromptScope = { ...opts.scope, vars };
  const result = await opts.engine.render(spec.body, scope);
  return result.text;
}
