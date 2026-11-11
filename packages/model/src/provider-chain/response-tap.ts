/**
 * Structured provider errors.
 *
 * pi-ai flattens a failed call to the OpenAI SDK's text (`"403 <message>"`) and
 * drops the response: its `onResponse` callback is not called for non-2xx, and the
 * client is created inside pi without a `fetch` option. So the status text is all
 * a classifier gets, and the body's `code`, `limit_source` and `Retry-After` are lost.
 *
 * This tap puts them back, per attempt. The chain tags an attempt's request with a
 * header; one process-wide `fetch` wrapper (installed once, pass-through for untagged
 * requests) strips the header, and for a non-2xx response reads a bounded copy of the
 * body and records the status, an allow-list of headers and the parsed error fields.
 * The chain then classifies from those fields, never from message text.
 *
 * Relies on the OpenAI SDK resolving `globalThis.fetch` when its client is created
 * (true for the openai version pi-ai uses). A host that injects its own fetch into
 * the client is not covered; the chain then falls back to the SDK's leading status.
 *
 * The tag is only sent while `globalThis.fetch` is still this tap: if anything
 * replaces the global afterwards (another wrapper, a test double, a second
 * installed copy of `@droveragent/model` whose own tap now sits on top), this tap
 * turns itself off for new attempts rather than send a tag nothing will strip.
 * Classification then falls back to the SDK's leading status.
 */
import { structuredFromBody, type RawFailure } from "./classify.ts";

const TAG_HEADER = "x-drover-attempt";
const MAX_BODY_BYTES = 16 * 1024;
const BODY_TIMEOUT_MS = 1_000;

/** Response headers worth keeping on a failure: rate-limit and request-id fields. Nothing else. */
export const KEPT_HEADERS: readonly string[] = [
  "retry-after",
  "retry-after-ms",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-tokens",
  "x-request-id",
  "cf-ray",
];

/** What the tap saw of a failed response. */
export interface AttemptResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed error body fields (`error.code`, `error.type`, `limit_source`). Never the message. */
  code?: string;
  limitSource?: string;
}

const records = new Map<string, AttemptResponse>();
/** Tags of attempts still running. A response for any other tag is ignored, so nothing is stored after `dispose()`. */
const live = new Set<string>();
let installed = false;
const MAX_HEADER_CHARS = 128;
/**
 * A kept header value must be plain: digits, letters and `._:,=/ -`. Anything
 * else (markup, quotes, control characters, a provider echoing request text) is
 * dropped, never truncated into something that looks safe.
 */
const SAFE_HEADER_VALUE = /^[A-Za-z0-9._:,=/ -]+$/;
/** The installed wrapper, to check that it is still the global. */
let tappedFetch: typeof fetch | null = null;

const newTag = (): string => crypto.randomUUID();

async function readBounded(res: { body: ReadableStream<Uint8Array> | null }): Promise<unknown> {
  if (!res.body) return undefined;
  try {
    return JSON.parse(await readBoundedText(res.body));
  } catch {
    return undefined;
  }
}

/**
 * At most `MAX_BODY_BYTES` of a body, as text, within `BODY_TIMEOUT_MS`; the rest is
 * cancelled. @internal (exported for tests).
 */
export async function readBoundedText(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  // The cap counts BYTES, and a single large chunk is sliced: a provider that sends
  // a 5 MB body in one chunk costs 16 KB here, not 5 MB.
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), BODY_TIMEOUT_MS);
  });
  try {
    while (bytes < MAX_BODY_BYTES) {
      const step = await Promise.race([reader.read(), deadline]);
      if (step === "timeout" || step.done) break;
      const chunk = step.value.subarray(0, MAX_BODY_BYTES - bytes);
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
  } catch {
    /* a broken body is no body */
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  return text;
}

/** Patch `globalThis.fetch` once. False when the global cannot be patched (frozen, or a runtime that forbids it): the tap is then off and no tag header is sent. */
function install(): boolean {
  if (installed) return true;
  const original = globalThis.fetch;
  if (typeof original !== "function") return false;
  const tapped = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const tag = headers.get(TAG_HEADER);
    if (!tag) return original(input, init);
    const tracked = live.has(tag);
    headers.delete(TAG_HEADER); // never leaves the process
    const res = await original(input instanceof Request ? new Request(input, { headers }) : input, {
      ...init,
      headers,
    });
    if (res.ok || !tracked) return res;
    const kept: Record<string, string> = {};
    for (const name of KEPT_HEADERS) {
      const v = res.headers.get(name);
      if (v === null) continue;
      const value = v.trim().slice(0, MAX_HEADER_CHARS);
      if (SAFE_HEADER_VALUE.test(value)) kept[name] = value;
    }
    const record: AttemptResponse = { status: res.status, headers: kept };
    // Read a bounded COPY: the SDK still gets the original body.
    Object.assign(record, structuredFromBody(await readBounded(res.clone())));
    if (live.has(tag)) records.set(tag, record);
    return res;
  };
  try {
    // Copy own properties (Bun's `fetch.preconnect` is non-enumerable) before the swap.
    for (const key of Reflect.ownKeys(original)) {
      if (key === "length" || key === "name" || key === "prototype") continue;
      const d = Object.getOwnPropertyDescriptor(original, key);
      if (d) Object.defineProperty(tapped, key, d);
    }
    globalThis.fetch = tapped as typeof fetch;
    if (globalThis.fetch !== tapped) return false;
    tappedFetch = tapped as typeof fetch;
  } catch {
    return false;
  }
  installed = true;
  return true;
}

/** One attempt's tap: add `header` to the request, `take()` the failed response afterwards. */
export interface AttemptTap {
  header: Record<string, string>;
  take(): AttemptResponse | undefined;
  dispose(): void;
}

export function startAttemptTap(): AttemptTap {
  // Off when the global cannot be patched, or when it is no longer this tap.
  if (!install() || globalThis.fetch !== tappedFetch)
    return { header: {}, take: () => undefined, dispose: () => {} };
  const tag = newTag();
  live.add(tag);
  return {
    header: { [TAG_HEADER]: tag },
    take: () => records.get(tag),
    dispose: () => {
      live.delete(tag);
      records.delete(tag);
    },
  };
}

/** `Retry-After` in ms from the kept headers: `retry-after-ms`, or seconds, or an HTTP date. */
export function retryAfterFromHeaders(h: Record<string, string>): number | undefined {
  const rawMs = h["retry-after-ms"];
  if (rawMs !== undefined && /^\d{1,12}(\.\d+)?$/.test(rawMs.trim()))
    return Math.round(Number(rawMs));
  const raw = h["retry-after"]?.trim();
  if (raw === undefined) return undefined;
  if (/^\d{1,12}(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  // An HTTP date ("Wed, 21 Oct 2026 07:28:00 GMT"); anything else that is present is malformed.
  if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)) {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  // Present but malformed: treated as beyond any cap, so the chain fails over instead of waiting.
  return Number.MAX_SAFE_INTEGER;
}

/** The structured RawFailure for a tapped response, with the SDK's message kept for the run's own text. */
export function rawFromResponse(res: AttemptResponse, message: string): RawFailure {
  const raw: RawFailure = { message, status: res.status };
  if (res.code !== undefined) raw.code = res.code;
  if (res.limitSource !== undefined) raw.limitSource = res.limitSource;
  if (Object.keys(res.headers).length > 0) raw.headers = res.headers;
  const wait = retryAfterFromHeaders(res.headers);
  if (wait !== undefined) raw.retryAfterMs = wait;
  return raw;
}

/** Test seam: whether the next attempt would be tapped (installed and still the global). */
export const attemptTapActive = (): boolean => installed && globalThis.fetch === tappedFetch;
