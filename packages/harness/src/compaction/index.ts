/**
 * Conversation-history compaction engine. Pure, injectable functions driven by
 * the harness from inside pi's `transformContext` seam, and exported for
 * consuming projects that want to drive compaction themselves.
 *
 * The policy *types* (`CompactionPolicy`, `CompactionStrategy`, …) and the
 * default summary prompt live in `@droveragent/core`; this module is the
 * behaviour.
 */
export { estimateTokens, messageChars } from "./estimate.ts";
export { selectHeadTail, type HeadTailSplit } from "./select.ts";
export { dropToolResults, CLEARED_PLACEHOLDER } from "./drop-tool-results.ts";
export { slidingWindow } from "./sliding-window.ts";
export {
  makeSummarizer,
  buildSummaryMessage,
  renderTranscript,
  summarizeStrategy,
  type SummarizeFn,
} from "./summarize.ts";
export {
  maybeCompact,
  initCompactionState,
  validateCompactionPolicy,
  type CompactionRunState,
  type MaybeCompactArgs,
} from "./maybe-compact.ts";
