import type { Fence, HarnessPlugin, ToolResult } from "@droveragent/core";
import { Effect } from "effect";

export interface UntrustedResultsOptions {
  /** The run's fence (`createFence()`); put `fence.note()` in the system prompt. */
  fence: Fence;
  /**
   * Which tools return outside text: a list of tool names, or a predicate.
   * Everything else passes through untouched.
   */
  tools: ReadonlyArray<string> | ((toolName: string) => boolean);
  /** Section label for a tool's block. Default: the tool name. */
  section?: (toolName: string) => string;
}

/**
 * Fence the results of tools that return text an outsider controls (a fetched
 * page, a mail body). The result content is cleaned and wrapped by the fence,
 * error results included (an error can quote the page). Already-fenced content
 * is left alone, so a tool that fences its own output is not double wrapped.
 */
export function untrustedResultsPlugin(opts: UntrustedResultsOptions): HarnessPlugin {
  const matches =
    typeof opts.tools === "function"
      ? opts.tools
      : (
          (names: ReadonlySet<string>) => (n: string) =>
            names.has(n)
        )(new Set(opts.tools));
  const sectionOf = opts.section ?? ((n: string) => n);
  return {
    id: "untrusted-results",
    afterToolCall: (toolName, _input, result) =>
      Effect.sync((): ToolResult => {
        if (!matches(toolName) || opts.fence.isFenced(result.content)) return result;
        return { ...result, content: opts.fence.wrapText(sectionOf(toolName), result.content) };
      }),
  };
}
