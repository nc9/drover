/**
 * Head/tail selection — which slice of the message array a compaction pass
 * may collapse, and what it must keep verbatim.
 *
 * Layout of the array after a split:
 *
 *   [ 0 .. prefixEnd )   preserved opener (the first user turn)
 *   [ headStart .. headEnd )   the compactable HEAD
 *   [ headEnd .. len )   verbatim recent TAIL
 *
 * `headStart === prefixEnd` and `headEnd === tailStart`. When `headEnd <=
 * headStart` the head is empty and there is nothing to compact (a no-op).
 *
 * A "turn" is an assistant message plus the tool results that follow it; we
 * count turns by assistant messages walking from the end, and pull in the
 * user message that prompted the earliest kept turn. Because the tail always
 * begins at a turn boundary, the head never ends on an assistant `toolCall`
 * whose `toolResult` lives in the tail — pairs are never split.
 */
import type { CompactionPreserve } from "@droveragent/core";
import type { Message } from "@mariozechner/pi-ai";

export interface HeadTailSplit {
  /** Messages `[0, prefixEnd)` are the preserved opener. */
  prefixEnd: number;
  /** Compactable head: `[headStart, headEnd)` in original indices. */
  headStart: number;
  headEnd: number;
}

/** Index where the verbatim tail (last `recentTurns` turns) begins. */
function tailStartIndex(messages: ReadonlyArray<Message>, recentTurns: number): number {
  if (recentTurns <= 0) return messages.length; // no verbatim tail
  let assistantSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role !== "assistant") continue;
    assistantSeen += 1;
    if (assistantSeen === recentTurns) {
      // Pull in the user message that prompted this turn, if present.
      return i - 1 >= 0 && messages[i - 1]!.role === "user" ? i - 1 : i;
    }
  }
  return 0; // fewer than recentTurns assistant turns → the whole array is "recent"
}

export function selectHeadTail(
  messages: ReadonlyArray<Message>,
  preserve: CompactionPreserve,
): HeadTailSplit {
  const prefixEnd =
    preserve.firstUserTurn && messages.length > 0 && messages[0]!.role === "user" ? 1 : 0;
  const tailStart = tailStartIndex(messages, preserve.recentTurns);
  const headEnd = Math.max(prefixEnd, tailStart);
  return { prefixEnd, headStart: prefixEnd, headEnd };
}
