/**
 * `sliding-window` strategy — mechanically delete the compactable head,
 * leaving `[preserved opener] + [verbatim tail]`. No summary, no model call.
 * The lossiest strategy (mid-conversation context is dropped outright), but
 * the cheapest; useful as a last-resort ladder rung when a summarize pass
 * itself cannot fit.
 */
import type { Message } from "@mariozechner/pi-ai";

export function slidingWindow(
  messages: ReadonlyArray<Message>,
  headStart: number,
  headEnd: number,
): Message[] {
  if (headEnd <= headStart) return [...messages];
  return [...messages.slice(0, headStart), ...messages.slice(headEnd)];
}
