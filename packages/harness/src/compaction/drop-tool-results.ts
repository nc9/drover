/**
 * `drop-tool-results` strategy — replace the *content* of old `toolResult`
 * messages in the head with a placeholder, keeping the message (and its
 * matching `toolCall` record in the preceding assistant turn) intact so the
 * causal trace survives. No model call. Re-fetchable tool output (long bash
 * logs, big file reads) is usually the biggest context consumer, so this is
 * the cheapest first rung.
 */
import type { Message, ToolResultMessage } from "@mariozechner/pi-ai";

export const CLEARED_PLACEHOLDER = "[cleared to save context]";

/**
 * Clear non-pinned `toolResult` content in `[headStart, headEnd)`. Returns a
 * new array (originals untouched) and whether anything changed — already-cleared
 * results and pinned tools are skipped, so the pass is idempotent.
 */
export function dropToolResults(
  messages: ReadonlyArray<Message>,
  headStart: number,
  headEnd: number,
  pinTools: ReadonlySet<string>,
): { messages: Message[]; changed: boolean } {
  const out = [...messages];
  let changed = false;
  for (let i = headStart; i < headEnd; i++) {
    const m = out[i]!;
    if (m.role !== "toolResult") continue;
    if (pinTools.has(m.toolName)) continue;
    const single = m.content.length === 1 ? m.content[0] : undefined;
    if (single && single.type === "text" && single.text === CLEARED_PLACEHOLDER) continue; // already cleared
    const cleared: ToolResultMessage = {
      ...m,
      content: [{ type: "text", text: CLEARED_PLACEHOLDER }],
    };
    out[i] = cleared;
    changed = true;
  }
  return { messages: out, changed };
}
