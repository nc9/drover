import type { AnyToolDef, Fence, HarnessPlugin } from "@droveragent/core";
import { Effect } from "effect";

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
   * for. Default `{ show_tool_result: "toolUseId" }`: tool name -> input field
   * holding the id.
   */
  readers?: Readonly<Record<string, string>>;
  /** Section label for a tool's block. Default: the tool name. */
  section?: (toolName: string) => string;
}

/**
 * Fence by provenance. Invariant: any result of an untrusted tool, and any
 * stored or derived copy of one handed back by a reader tool, reaches the model
 * inside the fence.
 *
 * - The results of matching tools are ALWAYS wrapped (errors included: an error
 *   can quote the page), with no check on what the content looks like. The only
 *   exception is the explicit `selfFenced` list.
 * - The tool-use ids of untrusted results are remembered per run. A reader tool
 *   asked for one of them gets its output wrapped as a slice of untrusted data.
 *
 * Wrapping happens in `wrapTool`, so list this plugin AFTER `truncatePlugin`
 * (outermost): the truncated head and its marker are then fenced, and the stored
 * overflow is only ever served through a reader, which this plugin fences. In
 * the other order it still holds (reads are fenced) but a slice carries a fence
 * inside a fence.
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
  /** runId -> tool-use ids whose results came from an untrusted tool. */
  const untrustedIds = new Map<string, Set<string>>();

  const wrapTool = (tool: AnyToolDef): AnyToolDef => {
    if (matches(tool.id) && !selfFenced.has(tool.id)) {
      return {
        ...tool,
        execute: (input, ctx) =>
          Effect.map(tool.execute(input, ctx), (result) => {
            let ids = untrustedIds.get(ctx.runId);
            if (!ids) untrustedIds.set(ctx.runId, (ids = new Set()));
            ids.add(ctx.toolUseId);
            return { ...result, content: opts.fence.wrapText(sectionOf(tool.id), result.content) };
          }),
      };
    }
    const idField = readers[tool.id];
    if (idField !== undefined) {
      return {
        ...tool,
        execute: (input, ctx) =>
          Effect.map(tool.execute(input, ctx), (result) => {
            const id = (input as Record<string, unknown> | null)?.[idField];
            if (typeof id !== "string" || !untrustedIds.get(ctx.runId)?.has(id)) return result;
            return {
              ...result,
              content: opts.fence.wrapText(`${sectionOf(tool.id)}-slice`, result.content),
            };
          }),
      };
    }
    return tool;
  };

  return {
    id: "untrusted-results",
    wrapTool,
    onRunEnd: (_result, ctx) => Effect.sync(() => void untrustedIds.delete(ctx.runId)),
  };
}
