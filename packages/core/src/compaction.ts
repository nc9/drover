/**
 * Conversation-history compaction primitives (data only — the engine lives
 * in `@droveragent/harness`). Leaf module: imports nothing from the rest of
 * core so `events.ts` can reference {@link CompactionStrategy} without forming
 * an import cycle (events → agent-spec → plugin → events).
 *
 * Drover ships these as composable primitives with NO opinionated defaults:
 * the caller declares the strategy, the trigger, and what to preserve. Absent
 * `spec.compaction` ⇒ no compaction (the historical behaviour). Recommended
 * values live in the guides, not in code.
 */

/**
 * How a compaction pass reclaims context. The policy lists strategies as an
 * ordered ladder; the harness applies them in turn until the trigger clears.
 *
 * - `drop-tool-results` — replace old `toolResult` message content with a
 *   placeholder, keeping the `toolCall` record so the causal trace survives.
 *   No model call. Cheapest; large re-fetchable tool output is usually the
 *   biggest consumer.
 * - `summarize` — an LLM sub-call condenses the compactable head into one
 *   synthetic message. Highest fidelity, costs tokens, requires `summaryPrompt`.
 * - `sliding-window` — mechanically delete the compactable head (no summary,
 *   no model call). Lossiest; cheapest of all.
 */
export type CompactionStrategy = "drop-tool-results" | "summarize" | "sliding-window";

/**
 * When auto-compaction fires. Omit `trigger` on a {@link CompactionPolicy} to
 * make compaction manual-only (driven by `handle.compact()`).
 */
export type CompactionTrigger =
  /** Fire when the estimated input crosses `value` × the model's context window (0.1–0.99). */
  | { kind: "context_fraction"; value: number }
  /** Fire when the estimated input crosses an absolute token count. */
  | { kind: "input_tokens"; value: number };

/**
 * What a compaction pass keeps verbatim, regardless of strategy. The system
 * prompt is always safe — pi sends it separately, so it is never part of the
 * message array compaction operates on.
 */
export interface CompactionPreserve {
  /** Keep the opening user turn (the original task) untouched. */
  firstUserTurn: boolean;
  /**
   * Keep the most-recent N model turns verbatim (a turn = an assistant message
   * plus the tool results that follow it, with its prompting user message).
   * The verbatim tail must stay last so the model acts on the freshest reality.
   */
  recentTurns: number;
  /**
   * Tool ids whose results are never compacted (e.g. `["remember","recall"]`
   * so externalised memory survives). Omit ⇒ no tool is pinned.
   */
  pinTools?: readonly string[];
}

/**
 * Drover's default summary-prompt text for the `summarize` strategy. Exported
 * so callers can use it explicitly (`summaryPrompt: DEFAULT_COMPACTION_SUMMARY_PROMPT`)
 * or build on it — there is no hidden default: a policy that lists `summarize`
 * without a `summaryPrompt` is a configuration error.
 */
export const DEFAULT_COMPACTION_SUMMARY_PROMPT = `You are compacting the conversation above to free context while preserving everything needed to continue the task. Write a single handoff summary for the same assistant, which will lose access to the raw history above and see only this summary plus the most recent turns.

Capture, in terse structured bullets:
- GOAL: the original task and any hard constraints or user preferences.
- PROGRESS: what is done, in progress, and blocked.
- DECISIONS: key technical choices and why.
- STATE: exact file paths, identifiers, commands, and error strings still in play — reproduce them verbatim, do not paraphrase.
- NEXT: the concrete next steps.

Do not call any tools. Respond with text only. Do not mention that you are summarizing or that context was compacted.`;

/** Marker prefixed to the synthetic summary message so the drop point is detectable. */
export const COMPACTION_SUMMARY_MARKER = "[compacted]";
