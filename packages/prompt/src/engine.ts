import { Liquid } from "liquidjs";
import type { Context, Emitter, Template } from "liquidjs";

import { BUILTINS } from "./builtins.ts";
import { analyzeTemplates } from "./cache-analysis.ts";
import { loadPromptFile } from "./loader.ts";
import type { CacheReport, PromptEngine, PromptScope, RenderOpts, RenderResult } from "./types.ts";

/** Reserved render-scope key carrying the drover `PromptScope`. */
const DROVER_KEY = "__drover";

function buildScope(scope: PromptScope): Record<string, unknown> {
  // `vars` feeds plain `{{ }}` outputs; builtins read `__drover`.
  return { ...scope.vars, [DROVER_KEY]: scope };
}

/**
 * Build a prompt engine: a LiquidJS instance with the drover builtins
 * registered as custom tags. Create once, reuse across renders — the
 * per-render `PromptScope` travels through the render call, not the
 * engine.
 */
export function createPromptEngine(): PromptEngine {
  const liquid = new Liquid();

  for (const builtin of BUILTINS) {
    liquid.registerTag(builtin.name, {
      render: async (ctx: Context, emitter: Emitter, hash: Record<string, unknown>) => {
        const scope = (ctx.getSync([DROVER_KEY]) as PromptScope | undefined) ?? {};
        emitter.write(await builtin.render(scope, hash));
      },
    });
  }

  const renderNodes = async (nodes: ReadonlyArray<Template>, scope: PromptScope): Promise<string> =>
    String(await liquid.render([...nodes], buildScope(scope)));

  const render = async (
    template: string,
    scope: PromptScope,
    opts?: RenderOpts,
  ): Promise<RenderResult> => {
    const parsed = liquid.parse(template);
    const { ordered, prefixCount, warnings, reordered } = analyzeTemplates(parsed, {
      autoReorder: opts?.autoReorder ?? false,
    });
    const text = await renderNodes(ordered, scope);
    // Re-render the leading static run alone to measure the cacheable
    // prefix. Prefix nodes are static, so this is cheap and deterministic;
    // it assumes no `{% assign %}` crosses the prefix boundary.
    const prefix =
      prefixCount >= ordered.length
        ? text
        : await renderNodes(ordered.slice(0, prefixCount), scope);
    return {
      text,
      cache: {
        cacheablePrefixChars: prefix.length,
        totalChars: text.length,
        warnings,
        reordered,
      },
    };
  };

  return {
    render,
    renderFile: async (path, scope, opts): Promise<RenderResult> =>
      render(await loadPromptFile(path), scope, opts),
    analyze: (template): CacheReport => {
      const parsed = liquid.parse(template);
      const { ordered, prefixCount, warnings } = analyzeTemplates(parsed, { autoReorder: false });
      // No run state — estimate the prefix from source spans.
      let prefixChars = 0;
      for (let i = 0; i < prefixCount; i++) {
        const t = ordered[i]!.token;
        prefixChars += t.end - t.begin;
      }
      return {
        cacheablePrefixChars: prefixChars,
        totalChars: template.length,
        warnings,
        reordered: false,
      };
    },
  };
}
