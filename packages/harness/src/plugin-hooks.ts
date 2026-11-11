import type { HarnessPlugin, RunContext } from "@droveragent/core";

import type { SummarizeFn } from "./compaction/index.ts";

/** Text plugins append to the system prompt (and the summariser's), in plugin order. */
export function systemAddenda(
  plugins: ReadonlyArray<HarnessPlugin>,
  ctx: RunContext,
): ReadonlyArray<string> {
  return plugins
    .map((p) => p.systemPromptAddendum?.(ctx))
    .filter((a): a is string => typeof a === "string" && a.trim() !== "");
}

/**
 * Plugins with fencing plugins (`wrapUntrusted`) moved to the end, order kept otherwise.
 * Used for `wrapTool` (so a fence wraps outermost) and `afterToolCall` (so a fence sees
 * every other plugin's rewrite last): registration order cannot weaken the fence.
 */
export function fencersLast(plugins: ReadonlyArray<HarnessPlugin>): ReadonlyArray<HarnessPlugin> {
  return [...plugins.filter((p) => !p.wrapUntrusted), ...plugins.filter((p) => p.wrapUntrusted)];
}

/** The fence for harness-made text derived from untrusted input; undefined without a fencing plugin. */
export function untrustedFencer(
  plugins: ReadonlyArray<HarnessPlugin>,
  ctx: RunContext,
): ((section: string, text: string) => string) | undefined {
  const fencers = plugins.filter((p) => p.wrapUntrusted);
  if (fencers.length === 0) return undefined;
  return (section, text) => fencers.reduce((t, p) => p.wrapUntrusted!(section, t, ctx), text);
}

/**
 * The compaction summary is derived from untrusted text and re-enters the
 * conversation as a user message, so a fencing plugin fences it first.
 */
export function fenceSummarizer(
  base: SummarizeFn,
  plugins: ReadonlyArray<HarnessPlugin>,
  ctx: RunContext,
): SummarizeFn {
  const fence = untrustedFencer(plugins, ctx);
  if (!fence) return base;
  return async (head, prompt, signal) =>
    fence("compaction-summary", await base(head, prompt, signal));
}
