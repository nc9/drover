import type { ProviderFailureClass } from "@droveragent/core";

/** What the chain knows about one failed provider call. */
export interface ProviderFailure {
  provider: string;
  failureClass: ProviderFailureClass;
  /** HTTP status when one is known, else null. */
  status: number | null;
  /** Allow-listed provider error code. */
  code?: string;
  /** Wait the provider asked for, in ms. */
  retryAfterMs?: number;
  /** Allow-listed response headers (rate limit, request id), when the response tap saw them. */
  headers?: Record<string, string>;
  /** The provider's text, truncated. Can quote the prompt: only used with `includeProviderText`; never in events. */
  message: string;
}

/**
 * What a classifier works from. Anything that can bench a provider (credits, key, region)
 * needs `status` plus, where the class says so, a field of the parsed error body. Message
 * text is never searched for those: provider errors echo request content (a rejected
 * prompt, a page title), so text an outsider controls could otherwise bench a provider.
 */
export interface RawFailure {
  /** pi-ai gives the OpenAI SDK's text, `"<status> <message>"`; only its leading status is read. */
  message: string;
  status?: number | null;
  /** From `Retry-After` or a structured field, in ms. */
  retryAfterMs?: number;
  /** `error.code` of the parsed body. */
  code?: string;
  /** `error.metadata.limit_source` (OpenRouter). */
  limitSource?: string;
  /** Allow-listed response headers, carried onto the failure. */
  headers?: Record<string, string>;
}

/** The gateway and its upstream use this code on a 403 for a region refusal. */
export const REGION_REFUSAL_CODE = "unsupported_country_region_territory";

const KNOWN_CODES: ReadonlySet<string> = new Set([
  REGION_REFUSAL_CODE,
  "insufficient_quota",
  "invalid_api_key",
]);

/** Fields of a parsed provider error body (`{ error: { code, metadata: { limit_source } } }`, or `error: [...]`). */
export function structuredFromBody(body: unknown): Pick<RawFailure, "code" | "limitSource"> {
  const root = body as { error?: unknown } | null | undefined;
  const e = (Array.isArray(root?.error) ? root.error[0] : root?.error) as
    | { code?: unknown; limit_source?: unknown; metadata?: { limit_source?: unknown } }
    | null
    | undefined;
  const out: Pick<RawFailure, "code" | "limitSource"> = {};
  if (typeof e?.code === "string") out.code = e.code;
  const ls = e?.metadata?.limit_source ?? e?.limit_source;
  if (typeof ls === "string") out.limitSource = ls;
  return out;
}

/**
 * Classify one failed call, status first:
 * 402, or 403 + `limit_source: openrouter_key_limit`, or 429 + `insufficient_quota` -> credits_exhausted;
 * 403 + the region code -> region_refused; 401 or 403 + `invalid_api_key` -> key_refused; any
 * other 403 -> forbidden (fails over, never benches: over the plain transport a bare 403 may be a
 * region, moderation or key refusal and only a structured field tells them apart); 429 -> rate_limited;
 * 404 -> model_unavailable; 504/408 or the SDK's own transport strings -> timeout; other 5xx -> provider_error;
 * 400/413/422 -> invalid_request; anything else -> other.
 * pi-ai flattens the error and drops the body, so over the plain transport the status is read from
 * the leading code of the SDK text (`"403 ..."`, the only place pi-ai keeps it) and a 403 is
 * `forbidden`; a custom stream or a response tap supplies `code`/`limitSource`.
 */
export function classifyFailure(provider: string, raw: RawFailure): ProviderFailure {
  const text = raw.message ?? "";
  const lead = /^\s*(\d{3})(?:\s|$)/.exec(text);
  const status = raw.status !== undefined ? raw.status : lead ? Number(lead[1]) : null;
  const out: ProviderFailure = {
    provider,
    failureClass: pick(text, status, raw),
    status,
    message: text.length > 300 ? `${text.slice(0, 300)}...` : text,
  };
  if (raw.code && KNOWN_CODES.has(raw.code)) out.code = raw.code;
  // Message text is a last resort and only for a 429 without a header; the chain caps any wait.
  const wait = raw.retryAfterMs ?? (status === 429 ? parseRetryAfterMs(text) : undefined);
  if (wait !== undefined) out.retryAfterMs = wait;
  if (raw.headers && Object.keys(raw.headers).length > 0) out.headers = raw.headers;
  return out;
}

function pick(text: string, status: number | null, raw: RawFailure): ProviderFailureClass {
  if (status === null) {
    const t = text.trim();
    if (
      /^(request timed out|connection error|fetch failed)\.?$/i.test(t) ||
      /^(econnreset|econnrefused|etimedout)\b/i.test(t)
    )
      return "timeout";
    return t.endsWith("(malformed response)") ? "malformed_response" : "other";
  }
  if (status === 402) return "credits_exhausted";
  if (status === 403) {
    if (raw.code === REGION_REFUSAL_CODE) return "region_refused";
    if (raw.limitSource === "openrouter_key_limit") return "credits_exhausted";
    return raw.code === "invalid_api_key" ? "key_refused" : "forbidden";
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

/** `Retry-After: 7` or OpenAI's `Please try again in 1.5s` / `250ms`. Only read on a 429. */
export function parseRetryAfterMs(text: string): number | undefined {
  const m =
    /retry[-\s]?after[\s:=]+(\d+(?:\.\d+)?)\s*(ms|s)?/i.exec(text) ??
    /try again in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(text);
  if (!m) return undefined;
  const ms = m[2]?.toLowerCase() === "ms" ? Number(m[1]) : Number(m[1]) * 1000;
  return Number.isFinite(ms) && ms >= 0 && ms <= 600_000 ? Math.round(ms) : undefined;
}

/**
 * Which classes fail over. A failure of the PROVIDER moves on; `invalid_request` would fail the
 * same way on the next provider, so it ends the chain. `retrySame`: wait out a `Retry-After`
 * first. `bench`: later calls of the same run skip this provider (money, key and place do not
 * heal in seconds); per run and per provider, never shared.
 */
export const FAILOVER: Readonly<
  Record<ProviderFailureClass, { failover: boolean; retrySame?: true; bench?: true }>
> = {
  credits_exhausted: { failover: true, bench: true },
  key_refused: { failover: true, bench: true },
  region_refused: { failover: true, bench: true },
  forbidden: { failover: true },
  rate_limited: { failover: true, retrySame: true },
  provider_error: { failover: true },
  timeout: { failover: true },
  malformed_response: { failover: true },
  model_unavailable: { failover: true },
  invalid_request: { failover: false },
  other: { failover: true },
};
