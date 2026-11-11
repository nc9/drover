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

/** Raw material a classifier works from: pi-ai gives an error message, not a response object. */
export interface RawFailure {
  message: string;
  /** Known status, when the caller has one (a fake provider, a custom transport). Else parsed from the message. */
  status?: number | null;
  /** Known `Retry-After`, in ms. */
  retryAfterMs?: number;
  /** Known error code. */
  code?: string;
}

/** Region refusal code the gateway and its upstream use on a 403. */
export const REGION_REFUSAL_CODE = "unsupported_country_region_territory";

/** Error codes passed through to events as they are. Anything else is dropped, never echoed. */
const KNOWN_CODES: readonly string[] = [
  REGION_REFUSAL_CODE,
  "insufficient_quota",
  "billing_hard_limit_reached",
  "invalid_api_key",
  "rate_limit_exceeded",
  "model_not_found",
  "context_length_exceeded",
  "openrouter_key_limit",
];

const MAX_MESSAGE_CHARS = 300;

/** Largest wait a message may claim; a longer figure is a parse accident, not a retry hint. */
const MAX_PARSED_WAIT_MS = 10 * 60_000;

/**
 * pi-ai ends a failed call with an assistant message whose `errorMessage` is
 * the OpenAI SDK's text: `"<status> <body message>"` for an HTTP error,
 * `"Connection error."` / `"Request timed out."` for transport failures. The
 * status and codes are read from that text, by fixed tokens only.
 */
export function classifyFailure(provider: string, raw: RawFailure): ProviderFailure {
  const text = raw.message ?? "";
  const status = raw.status !== undefined ? raw.status : parseStatus(text);
  const code = raw.code ?? parseCode(text);
  const retryAfterMs = raw.retryAfterMs ?? parseRetryAfterMs(text);
  const failureClass = pickClass(text, status, code);
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

function pickClass(
  text: string,
  status: number | null,
  code: string | undefined,
): ProviderFailureClass {
  const lower = text.toLowerCase();
  // Region first: it is a 403, and a key or credit class would mislead.
  if (code === REGION_REFUSAL_CODE || lower.includes(REGION_REFUSAL_CODE)) return "region_refused";
  if (
    status === 402 ||
    code === "insufficient_quota" ||
    code === "billing_hard_limit_reached" ||
    code === "openrouter_key_limit" ||
    lower.includes("insufficient_quota") ||
    lower.includes("openrouter_key_limit")
  ) {
    return "credits_exhausted";
  }
  if (status === 401 || status === 403 || code === "invalid_api_key") return "key_refused";
  if (status === 429 || code === "rate_limit_exceeded") return "rate_limited";
  if (status === 404 || code === "model_not_found") return "model_unavailable";
  if (status === 408 || status === 504) return "timeout";
  if (status !== null && status >= 500) return "provider_error";
  if (status === 400 || status === 413 || status === 422 || code === "context_length_exceeded") {
    return "invalid_request";
  }
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("connection error") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("fetch failed") ||
    lower.includes("network")
  ) {
    return "timeout";
  }
  if (
    lower.includes("unexpected token") ||
    lower.includes("unexpected end of json") ||
    lower.includes("invalid json") ||
    lower.includes("malformed") ||
    lower.includes("no choices") ||
    lower.includes("provider returned error")
  ) {
    return "malformed_response";
  }
  return "unknown";
}

/** Leading `"402 ..."` (the SDK's format), or an explicit `status 402` / `HTTP 402`. */
function parseStatus(text: string): number | null {
  const lead = /^\s*(\d{3})\b/.exec(text);
  if (lead) return Number(lead[1]);
  const named = /\b(?:status|http|code)[\s:=]+(\d{3})\b/i.exec(text);
  return named ? Number(named[1]) : null;
}

/**
 * The OpenAI SDK's error text is `"<status> <body.error.message>"`: the body's
 * `code` field is NOT in it. So a refusal that only carries its code in the
 * body (OpenAI's region refusal) is recognised by its fixed message, too.
 */
const REGION_REFUSAL_PHRASE = "country, region, or territory not supported";

function parseCode(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (lower.includes(REGION_REFUSAL_PHRASE)) return REGION_REFUSAL_CODE;
  return KNOWN_CODES.find((c) => lower.includes(c));
}

/** `Retry-After: 7`, `retry after 7s`, or OpenAI's `Please try again in 1.5s` / `250ms`. */
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
   * Skip this provider for later calls for this long (ms) after the class is
   * seen. Credits, keys and region do not heal in seconds, so asking again
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
 * `unknown` fails over: another provider is the cheap experiment.
 */
export const DEFAULT_FAILOVER_POLICY: FailoverPolicy = {
  credits_exhausted: { failover: true, retrySame: false, cooldownMs: FIVE_MINUTES },
  key_refused: { failover: true, retrySame: false, cooldownMs: FIVE_MINUTES },
  region_refused: { failover: true, retrySame: false, cooldownMs: FIVE_MINUTES },
  rate_limited: { failover: true, retrySame: true, cooldownMs: 0 },
  provider_error: { failover: true, retrySame: false, cooldownMs: 15_000 },
  timeout: { failover: true, retrySame: false, cooldownMs: 15_000 },
  malformed_response: { failover: true, retrySame: false, cooldownMs: 0 },
  model_unavailable: { failover: true, retrySame: false, cooldownMs: FIVE_MINUTES },
  invalid_request: { failover: false, retrySame: false, cooldownMs: 0 },
  unknown: { failover: true, retrySame: false, cooldownMs: 0 },
};
