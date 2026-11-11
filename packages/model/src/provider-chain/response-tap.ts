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
let installed = false;

const newTag = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

async function readBounded(res: { body: ReadableStream<Uint8Array> | null }): Promise<unknown> {
  const body = res.body;
  if (!body) return undefined;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), BODY_TIMEOUT_MS);
  });
  try {
    while (text.length < MAX_BODY_BYTES) {
      const step = await Promise.race([reader.read(), deadline]);
      if (step === "timeout" || step.done) break;
      text += decoder.decode(step.value, { stream: true });
    }
  } catch {
    /* a broken body is no body */
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function install(): void {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch;
  const tapped = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const tag = headers.get(TAG_HEADER);
    if (!tag) return original(input, init);
    headers.delete(TAG_HEADER); // never leaves the process
    const res = await original(input instanceof Request ? new Request(input, { headers }) : input, {
      ...init,
      headers,
    });
    if (res.ok) return res;
    const kept: Record<string, string> = {};
    for (const name of KEPT_HEADERS) {
      const v = res.headers.get(name);
      if (v !== null) kept[name] = v;
    }
    const record: AttemptResponse = { status: res.status, headers: kept };
    // Read a bounded COPY: the SDK still gets the original body.
    Object.assign(record, structuredFromBody(await readBounded(res.clone())));
    records.set(tag, record);
    return res;
  };
  globalThis.fetch = Object.assign(tapped, original) as typeof fetch;
}

/** One attempt's tap: add `header` to the request, `take()` the failed response afterwards. */
export interface AttemptTap {
  header: Record<string, string>;
  take(): AttemptResponse | undefined;
  dispose(): void;
}

export function startAttemptTap(): AttemptTap {
  install();
  const tag = newTag();
  return {
    header: { [TAG_HEADER]: tag },
    take: () => records.get(tag),
    dispose: () => void records.delete(tag),
  };
}

/** `Retry-After` in ms from the kept headers: `retry-after-ms`, or seconds, or an HTTP date. */
export function retryAfterFromHeaders(h: Record<string, string>): number | undefined {
  const ms = Number(h["retry-after-ms"]);
  if (h["retry-after-ms"] !== undefined && Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  const raw = h["retry-after"];
  if (raw === undefined) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
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
