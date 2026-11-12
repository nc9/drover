/**
 * Provider-failure classification for a run's final assistant message, and
 * the checkpoint scrub that keeps raw provider text out of storage. Internal:
 * not re-exported from the package index.
 */
import type { ProviderErrorDetails } from "@droveragent/core";
import { KNOWN_CODES } from "@droveragent/model";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** The slice of pi's assistant message the provider-failure check reads. */
export type ProviderMessage = {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: ReadonlyArray<{ type?: string; text?: string; thinking?: string }>;
  usage?: { output?: number };
  /** A provider chain's per-attempt failures (`type: "provider_failure"`): structured fields only. */
  diagnostics?: ReadonlyArray<{ type?: string; details?: Record<string, unknown> }>;
};

/** Provider names are operator config; still, only a plain token goes into the message. */
const NAME = /^[A-Za-z0-9._:/-]{1,64}$/;

/**
 * `provider: class status code` per chain failure, from the diagnostics' structured fields
 * (provider name, failure class, status, allow-listed code). Never the provider's text.
 * `status` is the last attempt's.
 */
function chainFailures(
  msg: ProviderMessage,
): { list: string; status: number | null; details: ProviderErrorDetails | undefined } | null {
  const parts: string[] = [];
  let status: number | null = null;
  let details: ProviderErrorDetails | undefined;
  for (const d of msg.diagnostics ?? []) {
    if (d?.type !== "provider_failure" || !d.details) continue;
    const { provider, failureClass, status: st, code } = d.details;
    if (typeof provider !== "string" || !NAME.test(provider)) continue;
    if (typeof failureClass !== "string" || !NAME.test(failureClass)) continue;
    const s = typeof st === "number" && Number.isInteger(st) && st >= 100 && st <= 599 ? st : null;
    const c = typeof code === "string" && NAME.test(code) ? code : null;
    parts.push([`${provider}: ${failureClass}`, s, c].filter((v) => v !== null).join(" "));
    status = s;
    details = detailsOf(d.details);
  }
  return parts.length > 0 ? { list: parts.join("; "), status, details } : null;
}

/**
 * The structured fields of one chain failure that may leave the harness (`error.details`):
 * plain tokens and a finite wait only. Undefined when none is known.
 */
function detailsOf(d: Record<string, unknown>): ProviderErrorDetails | undefined {
  const out: ProviderErrorDetails = {};
  // The chain's own allow-list, not just a token check: only codes the chain itself keeps.
  if (typeof d.code === "string" && KNOWN_CODES.has(d.code)) out.code = d.code;
  if (typeof d.type === "string" && NAME.test(d.type)) out.type = d.type;
  const w = d.retryAfterMs;
  // A malformed Retry-After is recorded as MAX_SAFE_INTEGER ("beyond any cap"): not a real wait.
  if (typeof w === "number" && Number.isFinite(w) && w >= 0 && w < Number.MAX_SAFE_INTEGER)
    out.retryAfterMs = Math.round(w);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A run-ending provider failure: status-only message, HTTP status and structured details when known. */
export interface ProviderFailure {
  message: string;
  status?: number;
  details?: ProviderErrorDetails;
}

/**
 * `stopReason: "error"` or `"aborted"` as a status-only failure, else null. pi
 * reports HTTP failures this way (it does not throw); the status is the leading
 * code of pi's message (`402 This request ...`). The raw text can quote prompt
 * content (a hostile page's words) and this message lands in events and
 * storage, so it is appended only when `includeText` is set. Under a provider
 * chain the message carries `provider_failure` diagnostics and every attempt is
 * listed: `provider error 401 (openrouter: credits_exhausted 402; cloudflare-ai-gateway: key_refused 401)`.
 */
export function providerError(
  msg: ProviderMessage | null,
  includeText: boolean,
): ProviderFailure | null {
  if (!msg || (msg.stopReason !== "error" && msg.stopReason !== "aborted")) return null;
  if (msg.stopReason === "aborted") return { message: "provider call aborted" };
  const raw = msg.errorMessage?.trim() ?? "";
  const chain = chainFailures(msg);
  if (chain) {
    const head = `provider error${chain.status !== null ? ` ${chain.status}` : ""} (${chain.list})`;
    return {
      message: includeText && raw !== "" ? `${head}: ${raw}` : head,
      ...(chain.status !== null ? { status: chain.status } : {}),
      // The last attempt's fields, like `status`.
      ...(chain.details ? { details: chain.details } : {}),
    };
  }
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
        : (providerError(
            {
              stopReason: "error",
              errorMessage: pm.errorMessage,
              ...(pm.diagnostics ? { diagnostics: pm.diagnostics } : {}),
            },
            false,
          )?.message ?? "provider error");
    return { ...m, errorMessage: head } as AgentMessage;
  });
}
