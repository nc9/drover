import type { ProviderFailureClass } from "@droveragent/core";

/** What the chain knows about one failed provider call. */
export interface ProviderFailure {
  /** Provider that failed (its `name`). */
  provider: string;
  failureClass: ProviderFailureClass;
  /** HTTP status when one could be read, else null (timeouts, malformed bodies). */
  status: number | null;
  /** Allow-listed provider error code, when the failure carried one. */
  code?: string;
  /** Wait the provider asked for (`Retry-After`, "try again in 2s"), in ms. */
  retryAfterMs?: number;
  /** The provider's own text, truncated. For the run's error message; never put in trace events. */
  message: string;
}

/**
 * Raw material a classifier works from. Everything that can DISABLE a provider
 * (credits, key, region) must be backed by `status` plus, where the class needs
 * it, a structured `code`/`limitSource` read from the parsed error body. Free
 * text is never searched for those: provider error messages echo request
 * content (a rejected prompt, a tool argument, a page title), so text an
 * outsider controls would otherwise be able to bench a provider.
 */
export interface RawFailure {
  /** The provider's or SDK's message. Only its leading `"<status> "` (SDK-generated) is read. */
  message: string;
  /** Known HTTP status (a custom transport, a thrown SDK error). Else the SDK's leading status. */
  status?: number | null;
  /** `Retry-After`, in ms, from a header or structured field. */
  retryAfterMs?: number;
  /** `error.code` of the parsed body, or the error object's own `code`. */
  code?: string;
  /** `error.type` of the parsed body. */
  type?: string;
  /** Provider documented metadata: OpenRouter's `error.metadata.limit_source`. */
  limitSource?: string;
}

/** Region refusal code the gateway and its upstream use on a 403 (structured only). */
export const REGION_REFUSAL_CODE = "unsupported_country_region_territory";

/** Structured codes passed through to events. Anything else is dropped, never echoed. */
const KNOWN_CODES: ReadonlySet<string> = new Set([
  REGION_REFUSAL_CODE,
  "insufficient_quota",
  "billing_hard_limit_reached",
  "invalid_api_key",
  "rate_limit_exceeded",
  "model_not_found",
  "context_length_exceeded",
]);

const MAX_MESSAGE_CHARS = 300;

/** Largest wait a message may claim; a longer figure is a parse accident, not a retry hint. */
const MAX_PARSED_WAIT_MS = 10 * 60_000;

/**
 * Pull the structured fields out of a parsed provider error body
 * (`{ error: { code, type, metadata: { limit_source } } }`, or the gateway's
 * `{ error: [{ code }] }`). Reads fields only, never message text.
 */
export function structuredFromBody(
  body: unknown,
): Pick<RawFailure, "code" | "type" | "limitSource"> {
  const out: Pick<RawFailure, "code" | "type" | "limitSource"> = {};
  const root = body as { error?: unknown } | null | undefined;
  const err = Array.isArray(root?.error) ? root.error[0] : root?.error;
  const e = err as
    | {
        code?: unknown;
        type?: unknown;
        limit_source?: unknown;
        metadata?: { limit_source?: unknown };
      }
    | null
    | undefined;
  if (typeof e?.code === "string") out.code = e.code;
  if (typeof e?.type === "string") out.type = e.type;
  const ls = e?.metadata?.limit_source ?? e?.limit_source;
  if (typeof ls === "string") out.limitSource = ls;
  return out;
}

/**
 * Classify one failed call, status first.
 *
 * pi-ai flattens a failed call to the OpenAI SDK's text, `"<status> <message>"`
 * (or `"Connection error."` / `"Request timed out."`), and drops the body, so
 * with that transport only the leading status is known. The classes that
 * disable a provider need more than free text can honestly give:
 *
 * - `credits_exhausted`: 402, or 403 with `limitSource === "openrouter_key_limit"`,
 *   or 429 with `code === "insufficient_quota"`.
 * - `region_refused`: 403 AND `code === REGION_REFUSAL_CODE`.
 * - `key_refused`: 401, or any other 403.
 *
 * A 403 whose body code was lost to flattening is therefore `key_refused`
 * (it still fails over). Fixing that needs structured errors from the
 * transport (a custom `stream`, or an upstream change in pi-ai).
 */
export function classifyFailure(provider: string, raw: RawFailure): ProviderFailure {
  const text = raw.message ?? "";
  const status = raw.status !== undefined ? raw.status : parseLeadingStatus(text);
  const code = raw.code && KNOWN_CODES.has(raw.code) ? raw.code : undefined;
  const retryAfterMs = raw.retryAfterMs ?? (status === 429 ? parseRetryAfterMs(text) : undefined);
  const failureClass = pickClass(text, status, raw);
  const out: ProviderFailure = {
    provider,
    failureClass,
    status,
    message: text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}...` : text,
  };
  if (code) out.code = code;
  if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
  return out;
}

function pickClass(text: string, status: number | null, raw: RawFailure): ProviderFailureClass {
  if (status !== null) {
    if (status === 402) return "credits_exhausted";
    if (status === 403) {
      if (raw.code === REGION_REFUSAL_CODE) return "region_refused";
      if (raw.limitSource === "openrouter_key_limit") return "credits_exhausted";
      return "key_refused";
    }
    if (status === 401) return "key_refused";
    if (status === 429)
      return raw.code === "insufficient_quota" ? "credits_exhausted" : "rate_limited";
    if (status === 404) return "model_unavailable";
    if (status === 408 || status === 504) return "timeout";
    if (status >= 500) return "provider_error";
    if (status === 400 || status === 413 || status === 422) return "invalid_request";
    return "other";
  }
  // No status: only the SDK's own transport strings, anchored, never a substring of content.
  if (/^(request timed out|connection error|fetch failed)\.?$/i.test(text.trim())) return "timeout";
  if (/^(econnreset|econnrefused|etimedout)\b/i.test(text.trim())) return "timeout";
  // The chain's own markers for an empty or truncated stream.
  if (text.endsWith("(malformed response)")) return "malformed_response";
  return "other";
}

/** The SDK's leading `"402 ..."`. SDK-generated, so a message body cannot forge it. */
function parseLeadingStatus(text: string): number | null {
  const lead = /^\s*(\d{3})(?:\s|$)/.exec(text);
  return lead ? Number(lead[1]) : null;
}

/** `Retry-After: 7`, `retry after 7s`, or OpenAI's `Please try again in 1.5s` / `250ms`. Only read on a 429. */
export function parseRetryAfterMs(text: string): number | undefined {
  const header = /retry[-\s]?after[\s:=]+(\d+(?:\.\d+)?)\s*(ms|s)?/i.exec(text);
  const prose = /try again in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(text);
  const m = header ?? prose;
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const ms = m[2]?.toLowerCase() === "ms" ? n : n * 1000;
  return ms >= 0 && ms <= MAX_PARSED_WAIT_MS ? Math.round(ms) : undefined;
}

/** What the chain does with each class. */
export interface FailoverPolicyEntry {
  /** Try the next provider. False ends the chain on this failure. */
  failover: boolean;
  /** Retry the same provider (after the wait) before failing over. */
  retrySame: boolean;
  /**
   * Skip this provider for later calls OF THE SAME RUN for this long (ms)
   * after the class is seen. Scoped to one run and one provider; nothing is
   * shared across runs. Credits, keys and region do not heal in seconds, so asking again
   * every turn costs a round trip each time.
   */
  cooldownMs: number;
}

export type FailoverPolicy = Readonly<Record<ProviderFailureClass, FailoverPolicyEntry>>;

const FIVE_MINUTES = 5 * 60_000;

/**
 * Which failures fail over. The rule: a failure of the PROVIDER (money, key,
 * place, capacity, transport, a broken body, a model it does not serve) moves
 * on; a failure of the REQUEST (`invalid_request`: context too long, bad
 * params) would fail the same way on the next provider and ends the chain.
 * `other` fails over for this call only: another provider is the cheap experiment.
 */
export const DEFAULT_FAILOVER_POLICY: FailoverPolicy = {
  credits_exhausted: { failover: true, retrySame: false, cooldownMs: FIVE_MINUTES },
  key_refused: { failover: true, retrySame: false, cooldownMs: FIVE_MINUTES },
  region_refused: { failover: true, retrySame: false, cooldownMs: FIVE_MINUTES },
  rate_limited: { failover: true, retrySame: true, cooldownMs: 0 },
  provider_error: { failover: true, retrySame: false, cooldownMs: 15_000 },
  // Not status-backed when it comes from a transport string: never benched.
  timeout: { failover: true, retrySame: false, cooldownMs: 0 },
  malformed_response: { failover: true, retrySame: false, cooldownMs: 0 },
  model_unavailable: { failover: true, retrySame: false, cooldownMs: FIVE_MINUTES },
  invalid_request: { failover: false, retrySame: false, cooldownMs: 0 },
  other: { failover: true, retrySame: false, cooldownMs: 0 },
};
