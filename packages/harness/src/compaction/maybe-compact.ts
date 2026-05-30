/**
 * The compaction orchestrator. Runs inside pi's `transformContext` (before each
 * LLM call). Decides whether to fire, applies the strategy ladder until the
 * trigger clears, emits one `compaction` event per committed pass, and tracks
 * per-run state for cooldown.
 *
 * Contract: NEVER throws. `transformContext` must not reject, so any internal
 * failure (a summariser error, an estimation bug) emits an `error` event tagged
 * `"CompactionError"` and returns the ORIGINAL messages — the run continues
 * uncompacted rather than dying.
 *
 * Persistence: pi keeps its own `context.messages` and uses `transformContext`'s
 * return value only transiently (for that one call's `convertToLlm`) — it does
 * NOT reassign its list to the result. So a committed pass mutates the passed
 * array IN PLACE; that array is `context.messages` by reference, the canonical
 * growing list pi appends to. Without in-place mutation a compaction would not
 * survive to the next turn — `summarize` would re-run every call and cheap
 * passes would recompute endlessly. In-place mutation makes compaction durable
 * (cooldown keeps the list short between passes) and `summarize` incremental (a
 * later pass re-summarises the prior summary message + new turns).
 */
import type { CompactionPolicy, HarnessEvent } from "@droveragent/core";
import type { Message } from "@mariozechner/pi-ai";

import { dropToolResults } from "./drop-tool-results.ts";
import { estimateTokens } from "./estimate.ts";
import { selectHeadTail } from "./select.ts";
import { slidingWindow } from "./sliding-window.ts";
import { summarizeStrategy, type SummarizeFn } from "./summarize.ts";

/** Per-run mutable compaction state (cooldown bookkeeping). */
export interface CompactionRunState {
  /** Turn of the last committed pass; -1 = never compacted this run. */
  lastCompactedTurn: number;
}

export function initCompactionState(): CompactionRunState {
  return { lastCompactedTurn: -1 };
}

/**
 * Validate a policy at run start — fast-fail before any LLM call. Returns an
 * error message, or `null` when the policy is internally consistent.
 */
export function validateCompactionPolicy(policy: CompactionPolicy): string | null {
  if (policy.strategy.length === 0) {
    return "spec.compaction.strategy must list at least one strategy";
  }
  if (
    policy.strategy.includes("summarize") &&
    (policy.summaryPrompt === undefined || policy.summaryPrompt.trim().length === 0)
  ) {
    return 'spec.compaction.strategy includes "summarize" but no summaryPrompt is set — provide summaryPrompt (import DEFAULT_COMPACTION_SUMMARY_PROMPT for drover\'s shipped text)';
  }
  if (policy.trigger?.kind === "context_fraction") {
    const v = policy.trigger.value;
    if (!(v > 0 && v < 1)) {
      return `spec.compaction.trigger.value must be in (0,1) for context_fraction, got ${v}`;
    }
  }
  if (policy.trigger?.kind === "input_tokens" && policy.trigger.value <= 0) {
    return `spec.compaction.trigger.value must be > 0 for input_tokens, got ${policy.trigger.value}`;
  }
  if (policy.preserve.recentTurns < 0) {
    return `spec.compaction.preserve.recentTurns must be >= 0, got ${policy.preserve.recentTurns}`;
  }
  return null;
}

export interface MaybeCompactArgs {
  /** The live message list pi is about to send. */
  messages: Message[];
  policy: CompactionPolicy;
  /** Model context window (`resolved.model.contextWindow`) — for `context_fraction`. */
  contextWindow: number;
  /** Current turn index (`translator.currentTurn()`). */
  currentTurn: number;
  state: CompactionRunState;
  runId: string;
  emit: (e: HarnessEvent) => void;
  /** Pi-backed summariser; absent ⇒ the `summarize` rung is skipped. */
  summarize?: SummarizeFn;
  /** Present when `handle.compact()` requested this pass; overrides `summaryPrompt`. */
  manual?: { instructions?: string };
  signal?: AbortSignal;
}

/** Token ceiling that must be crossed to auto-fire, or null for manual-only policies. */
function usableTokens(policy: CompactionPolicy, contextWindow: number): number | null {
  const t = policy.trigger;
  if (!t) return null;
  return t.kind === "context_fraction" ? Math.floor(contextWindow * t.value) : t.value;
}

export async function maybeCompact(args: MaybeCompactArgs): Promise<Message[]> {
  const {
    messages,
    policy,
    contextWindow,
    currentTurn,
    state,
    runId,
    emit,
    summarize,
    manual,
    signal,
  } = args;
  try {
    if (signal?.aborted) return messages;

    const isManual = manual !== undefined;
    const usable = usableTokens(policy, contextWindow);

    // Decide whether to run at all (manual always runs; auto gates on
    // trigger presence, cooldown, then the token estimate).
    if (!isManual) {
      if (usable === null) return messages; // manual-only policy, no auto-fire
      if (
        policy.cooldownTurns !== undefined &&
        state.lastCompactedTurn >= 0 &&
        currentTurn - state.lastCompactedTurn < policy.cooldownTurns
      ) {
        return messages;
      }
      if (estimateTokens(messages) < usable) return messages; // under budget
    }

    const pinSet = new Set<string>(policy.preserve.pinTools ?? []);
    const summaryPrompt = manual?.instructions ?? policy.summaryPrompt ?? "";
    const now = Date.now();

    let cur: Message[] = messages;

    for (const strategy of policy.strategy) {
      // Re-derive the split on the CURRENT array each rung (prior rungs shrank it).
      const { headStart, headEnd } = selectHeadTail(cur, policy.preserve);
      if (headEnd <= headStart) continue; // nothing left to compact

      const before = estimateTokens(cur);
      let candidate: Message[];

      if (strategy === "drop-tool-results") {
        const res = dropToolResults(cur, headStart, headEnd, pinSet);
        if (!res.changed) continue;
        candidate = res.messages;
      } else if (strategy === "sliding-window") {
        candidate = slidingWindow(cur, headStart, headEnd);
      } else {
        // summarize — skip if no summariser wired or no prompt for this pass
        if (!summarize || summaryPrompt.trim().length === 0) continue;
        candidate = await summarizeStrategy(
          cur,
          headStart,
          headEnd,
          summarize,
          summaryPrompt,
          now,
          signal,
        );
      }

      const after = estimateTokens(candidate);
      const reclaim = before - after;
      if (reclaim <= 0) continue;
      // Min-reclaim guard against prompt-cache thrash (cf. Anthropic clear_at_least).
      if (policy.minReclaimTokens !== undefined && reclaim < policy.minReclaimTokens) continue;

      // Commit IN PLACE immediately (see the module header): replace the passed
      // array's contents so the compaction persists into pi's canonical list AND
      // a later-rung failure keeps this progress (the catch returns what's already
      // persisted, not the pristine original). A plain loop (not spread) avoids
      // call-arg limits on large lists.
      messages.length = 0;
      for (const m of candidate) messages.push(m);
      cur = messages;
      state.lastCompactedTurn = currentTurn;
      emit({
        kind: "compaction",
        runId,
        turn: currentTurn,
        trigger: isManual ? "manual" : "auto",
        strategy,
        beforeTokens: before,
        afterTokens: after,
        collapsedRange: [headStart, headEnd],
        summarized: strategy === "summarize",
        ts: Date.now(),
      });

      // Keep climbing the ladder only while a budget exists and we're still over it.
      // (Manual-only policies have no budget, so a single committed pass is enough.)
      if (usable !== null && estimateTokens(cur) >= usable) continue;
      break;
    }

    return messages;
  } catch (err) {
    emit({
      kind: "error",
      runId,
      tag: "CompactionError",
      message: `compaction failed, continuing uncompacted: ${(err as Error).message}`,
      ts: Date.now(),
    });
    return messages;
  }
}
