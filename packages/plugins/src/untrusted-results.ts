import type { AnyToolDef, Fence, HarnessPlugin } from "@droveragent/core";

import type { TruncateStore } from "./truncate.ts";
import { Cause, Effect } from "effect";

export interface UntrustedResultsOptions {
  /** The run's fence (`createFence()`); put `fence.note()` in the system prompt. */
  fence: Fence;
  /**
   * Which tools return outside text: a list of tool names, or a predicate.
   * Everything else passes through untouched.
   */
  tools: ReadonlyArray<string> | ((toolName: string) => boolean);
  /**
   * Tools that already fence their own output (they call `fence.wrap`). Their
   * results are not wrapped again. This is an explicit list, never inferred
   * from what the output looks like: output is the untrusted part.
   */
  selfFenced?: ReadonlyArray<string>;
  /**
   * Tools that read back a stored or derived copy of an earlier result by its
   * tool-use id (the truncate plugin's `show_tool_result`). Reads of a result
   * that came from an untrusted tool come back fenced, whatever slice is asked
   * for. Fenced unless the id is marked trusted. Default
   * `{ show_tool_result: "toolUseId" }`: tool name -> input field holding the id.
   */
  readers?: Readonly<Record<string, string>>;
  /**
   * The store the reader tools read from (`truncatePlugin().store`). Provenance is
   * read from the entry it returns. Without it every reader read is fenced.
   */
  store?: TruncateStore;
  /** Section label for a tool's block. Default: the tool name. */
  section?: (toolName: string) => string;
}

/**
 * INVARIANT: anything a tool returns is untrusted unless positively marked
 * trusted, and the mark is stored with the data it describes. Fail closed.
 *
 * - Results of matching tools are ALWAYS wrapped, with no look at the content,
 *   errors and defects included (an upstream error can echo a page title). The
 *   only exception to wrapping is the explicit `selfFenced` list.
 * - A reader tool (a stored copy by id: the truncate plugin's `show_tool_result`)
 *   is fenced UNLESS the store entry it just read says `trusted: true`. That flag
 *   is written by the truncate plugin at the moment the content is stored
 *   (`trustedTools`, default none), keyed by (run id, tool-use id). A missing
 *   entry, a legacy entry without the flag, another run's entry, a failed call
 *   that stored nothing, or no store at all reads as untrusted.
 * - No side maps: this plugin keeps no record of ids. Provenance lives in the
 *   store entry and travels with the data (a store carried across runs or into a
 *   resumed run brings its flags along).
 *
 * Wrapping happens in `wrapTool`; list this plugin AFTER `truncatePlugin`
 * (outermost) so the truncated head and its marker are fenced too.
 */
export function untrustedResultsPlugin(opts: UntrustedResultsOptions): HarnessPlugin {
  const matches =
    typeof opts.tools === "function"
      ? opts.tools
      : (
          (names: ReadonlySet<string>) => (n: string) =>
            names.has(n)
        )(new Set(opts.tools));
  const selfFenced = new Set(opts.selfFenced ?? []);
  const readers = opts.readers ?? { show_tool_result: "toolUseId" };
  const sectionOf = opts.section ?? ((n: string) => n);

  const wrapTool = (tool: AnyToolDef): AnyToolDef => {
    if (matches(tool.id)) {
      const wrap = !selfFenced.has(tool.id);
      const fenceText = (text: string): string =>
        wrap ? opts.fence.wrapText(sectionOf(tool.id), text) : text;
      return {
        ...tool,
        execute: (input, ctx) =>
          tool.execute(input, ctx).pipe(
            Effect.map((result) => ({ ...result, content: fenceText(result.content) })),
            Effect.catchAllCause((cause) =>
              Cause.isInterruptedOnly(cause)
                ? Effect.failCause(cause)
                : Effect.succeed({
                    content: opts.fence.wrapText(sectionOf(tool.id), errorText(cause)),
                    isError: true,
                  }),
            ),
          ),
      };
    }
    const idField = readers[tool.id];
    if (idField !== undefined) {
      const slice = (text: string): string =>
        opts.fence.wrapText(`${sectionOf(tool.id)}-slice`, text);
      return {
        ...tool,
        execute: (input, ctx) => {
          const id = (input as Record<string, unknown> | null)?.[idField];
          // The entry's own flag decides; anything else is untrusted.
          const trusted =
            typeof id === "string" && opts.store?.get(id, ctx.runId)?.trusted === true;
          return tool.execute(input, ctx).pipe(
            Effect.map((result) =>
              trusted ? result : { ...result, content: slice(result.content) },
            ),
            // A reader's failure can quote the id or the data it looked for.
            Effect.catchAllCause((cause) =>
              Cause.isInterruptedOnly(cause)
                ? Effect.failCause(cause)
                : Effect.succeed({ content: slice(errorText(cause)), isError: true }),
            ),
          );
        },
      };
    }
    return tool;
  };

  return { id: "untrusted-results", wrapTool };
}

function errorText(cause: Cause.Cause<unknown>): string {
  const e = Cause.squash(cause);
  return e instanceof Error
    ? e.message
    : typeof e === "string"
      ? e
      : (JSON.stringify(e) ?? String(e));
}
