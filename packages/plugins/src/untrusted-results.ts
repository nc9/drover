import type { AnyToolDef, Fence, HarnessPlugin } from "@droveragent/core";
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
  /** Section label for a tool's block. Default: the tool name. */
  section?: (toolName: string) => string;
}

/**
 * INVARIANT: anything a tool returns is untrusted unless it is positively marked
 * trusted. Fail closed: every bookkeeping miss (an id never recorded, a record
 * dropped when the run ended, a process restart, a resumed run) over-fences; none
 * can under-fence.
 *
 * - Results of matching tools are ALWAYS wrapped, with no look at the content,
 *   errors and defects included (an upstream error can echo a page title). The
 *   only exception to wrapping is the explicit `selfFenced` list. Matching tools
 *   are never marked trusted, self-fenced ones included.
 * - Every other tool's call is positively marked trusted (by run and tool-use id)
 *   before it runs. A reader tool (a stored or derived copy by id, such as the
 *   truncate plugin's `show_tool_result`) returns its output fenced UNLESS the id
 *   it was asked for is marked trusted. An id the plugin never saw, or one whose
 *   mark was cleared at run end, is therefore fenced.
 * - The mark lives in this plugin, keyed by (run id, tool-use id), and is cleared
 *   at run end. Data that outlives the mark (a store shared across runs, a resumed
 *   run) simply reads back fenced. Persisting the mark with the stored entry would
 *   stop that over-fencing; it is not needed for safety.
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
  /** runId -> tool-use ids positively marked trusted. Everything else is untrusted. */
  const trustedIds = new Map<string, Set<string>>();
  const markTrusted = (runId: string, id: string): void => {
    let ids = trustedIds.get(runId);
    if (!ids) trustedIds.set(runId, (ids = new Set()));
    ids.add(id);
  };

  const wrapTool = (tool: AnyToolDef): AnyToolDef => {
    if (matches(tool.id)) {
      const wrap = !selfFenced.has(tool.id);
      const fenceText = (text: string): string =>
        wrap ? opts.fence.wrapText(sectionOf(tool.id), text) : text;
      return {
        ...tool,
        // Not marked trusted, before or after: a failed call has no trusted mark either.
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
          const trusted = typeof id === "string" && trustedIds.get(ctx.runId)?.has(id) === true;
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
    return {
      ...tool,
      execute: (input, ctx) => {
        markTrusted(ctx.runId, ctx.toolUseId);
        return tool.execute(input, ctx);
      },
    };
  };

  return {
    id: "untrusted-results",
    wrapTool,
    onRunEnd: (_result, ctx) => Effect.sync(() => void trustedIds.delete(ctx.runId)),
  };
}

function errorText(cause: Cause.Cause<unknown>): string {
  const e = Cause.squash(cause);
  return e instanceof Error
    ? e.message
    : typeof e === "string"
      ? e
      : (JSON.stringify(e) ?? String(e));
}
