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
  usage?: { output?: number };
};

/** A run-ending provider failure: status-only message, HTTP status when known. */
export interface ProviderFailure {
  message: string;
  status?: number;
}

/**
 * `stopReason: "error"` or `"aborted"` as a status-only failure, else null. pi
 * reports HTTP failures this way (it does not throw); the status is the leading
 * code of pi's message (`402 This request ...`). The raw text can quote prompt
 * content (a hostile page's words) and this message lands in events and
 * storage, so it is appended only when `includeText` is set.
 */
export function providerError(
  msg: ProviderMessage | null,
  includeText: boolean,
): ProviderFailure | null {
  if (!msg || (msg.stopReason !== "error" && msg.stopReason !== "aborted")) return null;
  if (msg.stopReason === "aborted") return { message: "provider call aborted" };
  const raw = msg.errorMessage?.trim() ?? "";
  const code = /^([45]\d\d)\b/.exec(raw)?.[1];
  const head = code ? `provider error ${code}` : "provider error";
  return {
    message: includeText && raw !== "" ? `${head}: ${raw}` : head,
    ...(code ? { status: Number(code) } : {}),
  };
}

/**
 * Why the run's final assistant message is a provider failure, or null.
 *
 * - `stopReason: "error"`: see {@link providerError}.
 * - `aborted`: a cancel or a budget breach, handled elsewhere.
 * - An answer (a tool call or non-blank text) is never a failure.
 * - `stopReason: "length"` with no answer (thinking only): the model hit its
 *   token cap before answering.
 * - Otherwise no answer is an empty completion only when the stream produced
 *   nothing (zero output tokens) or this is the run's first assistant message.
 *   A model may legitimately end with an empty turn after tool work, so an
 *   empty end with output tokens after earlier turns stays a success.
 * - No assistant message at all: the stream produced nothing.
 */
export function providerFailure(
  msg: ProviderMessage | null,
  includeText: boolean,
  firstAssistant = true,
): ProviderFailure | null {
  if (!msg) return { message: "provider returned no assistant message" };
  if (msg.stopReason === "aborted") return null;
  const err = providerError(msg, includeText);
  if (err) return err;
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const answered = blocks.some(
    (b) => b.type === "toolCall" || (b.type === "text" && (b.text ?? "").trim() !== ""),
  );
  if (answered) return null;
  if (msg.stopReason === "length") return { message: "model hit max tokens before answering" };
  const output = msg.usage?.output ?? 0;
  return output === 0 || firstAssistant
    ? { message: "provider returned an empty completion (no content)" }
    : null;
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
        : (providerError({ stopReason: "error", errorMessage: pm.errorMessage }, false)?.message ??
          "provider error");
    return { ...m, errorMessage: head } as AgentMessage;
  });
}
