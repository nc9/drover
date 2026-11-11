/**
 * Provider-failure classification for a run's final assistant message, and
 * the checkpoint scrub that keeps raw provider text out of storage. Internal:
 * not re-exported from the package index.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** The slice of pi's assistant message the provider-failure check reads. */
export type ProviderMessage = {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: ReadonlyArray<{ type?: string; text?: string; thinking?: string }>;
};

/**
 * Why the final assistant message is a provider failure, or null if it is not.
 *
 * - `stopReason: "error"` (pi reports HTTP failures this way, it does not
 *   throw): `provider error <status>`, status read from the leading code of
 *   pi's message (`402 This request ...`). The raw text can quote prompt
 *   content (a hostile page's words) and this message lands in events and
 *   storage, so it is appended only when `includeText` is set.
 * - `aborted`: a cancel, handled elsewhere.
 * - Empty completion: no tool call and no non-blank text. Thinking alone is
 *   empty (the run has no answer); a tool-call-only message is not.
 * - No assistant message at all: the stream produced nothing.
 */
export function providerFailure(msg: ProviderMessage | null, includeText: boolean): string | null {
  if (!msg) return "provider returned no assistant message";
  if (msg.stopReason === "error") {
    const raw = msg.errorMessage?.trim() ?? "";
    const code = /^([45]\d\d)\b/.exec(raw)?.[1];
    const head = code ? `provider error ${code}` : "provider error";
    return includeText && raw !== "" ? `${head}: ${raw}` : head;
  }
  if (msg.stopReason === "aborted") return null;
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const answered = blocks.some(
    (b) => b.type === "toolCall" || (b.type === "text" && (b.text ?? "").trim() !== ""),
  );
  return answered ? null : "provider returned an empty completion (no content)";
}

/**
 * Checkpoint copy of the message history with pi's raw provider `errorMessage`
 * replaced by its status-only form, so storage carries no provider text by
 * default (same rule as `ProviderError` messages). Untouched messages are
 * shared, not copied.
 */
export function scrubProviderErrorText(
  messages: ReadonlyArray<AgentMessage>,
): ReadonlyArray<AgentMessage> {
  return messages.map((m) => {
    const pm = m as ProviderMessage;
    if (pm.role !== "assistant" || typeof pm.errorMessage !== "string") return m;
    const head =
      pm.stopReason === "aborted"
        ? "aborted"
        : providerFailure({ stopReason: "error", errorMessage: pm.errorMessage }, false);
    return { ...m, errorMessage: head } as AgentMessage;
  });
}
