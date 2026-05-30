/**
 * Token estimation for the compaction trigger.
 *
 * We estimate from the live message array (not from `lastUsage`): the harness
 * *accumulates* `inputTokens` across calls, so that counter is a cumulative
 * total, not the current context size. The array passed to `transformContext`
 * is exactly what is about to be sent, so a `chars / CHARS_PER_TOKEN` heuristic
 * over its rendered content is the most direct, self-contained signal — the
 * same `~4 chars/token` rule opencode uses for head/tail selection.
 */
import type { ImageContent, Message, TextContent } from "@mariozechner/pi-ai";

const CHARS_PER_TOKEN = 4;
/** Flat per-image estimate (base64 length wildly overstates real image tokens). */
const IMAGE_CHARS = 1500;
/** Per-message structural overhead (role tags, delimiters). */
const MESSAGE_OVERHEAD_CHARS = 8;

function contentChars(content: ReadonlyArray<TextContent | ImageContent>): number {
  let n = 0;
  for (const c of content) n += c.type === "text" ? c.text.length : IMAGE_CHARS;
  return n;
}

/** Rough character footprint of a single message. */
export function messageChars(message: Message): number {
  let n = MESSAGE_OVERHEAD_CHARS;
  if (message.role === "user") {
    n +=
      typeof message.content === "string" ? message.content.length : contentChars(message.content);
  } else if (message.role === "assistant") {
    for (const c of message.content) {
      if (c.type === "text") n += c.text.length;
      else if (c.type === "thinking") n += c.thinking.length;
      else if (c.type === "toolCall") n += c.name.length + JSON.stringify(c.arguments).length;
    }
  } else {
    // toolResult
    n += message.toolName.length + contentChars(message.content);
  }
  return n;
}

/** Estimated input-token count for a message list. */
export function estimateTokens(messages: ReadonlyArray<Message>): number {
  let chars = 0;
  for (const m of messages) chars += messageChars(m);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
