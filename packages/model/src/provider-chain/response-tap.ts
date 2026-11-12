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
 * The same tag also carries provider-billed cost (`withProviderCost`, the chain's
 * `billedCost`): pi-ai drops OpenRouter's `usage.cost`, so for an attempt opened
 * with `{ cost: true }` a 2xx body is teed and its `usage.cost` read. One
 * mechanism, one header, one `fetch` patch for both.
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
  /**
   * A `Retry-After` / `retry-after-ms` header was present but not a valid value
   * (so it is not in `headers`): the wait is treated as beyond any cap.
   */
  retryAfterMalformed?: true;
  /** Parsed error body fields (`error.code`, `error.type`, `limit_source`). Never the message. */
  code?: string;
  limitSource?: string;
}

const records = new Map<string, AttemptResponse>();
/** Billed-cost waiters, for attempts opened with `{ cost: true }`. */
const costs = new Map<string, (cost: number | undefined) => void>();
/** The tap's reader of a 2xx body being read for its cost, per tag (cancelled on settle or dispose). */
const costReaders = new Map<string, BodyReader>();
/**
 * Tags whose 2xx body the caller has read to its end. The tee then holds the whole body for the
 * tap's reader, so the cost settles from local data alone: `cost()` waits for it with no
 * wall-clock window.
 */
const costBodyEnded = new Set<string>();
/** The part of a stream reader the tap uses (structural: runtimes type readers differently). */
interface BodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}
/** Longest the tap reads a 2xx body for its cost: a streamed answer, so generous. */
const COST_BODY_TIMEOUT_MS = 10 * 60_000;
/** A line longer than this cannot be a usage chunk worth parsing: dropped, not buffered. */
const MAX_COST_LINE_CHARS = 64 * 1024;
/** Tags of attempts still running. A response for any other tag is ignored, so nothing is stored after `dispose()`. */
const live = new Set<string>();
let installed = false;
const MAX_HEADER_CHARS = 128;
/** Seconds (or ms), optionally fractional. */
const NUMBER_VALUE = /^\d{1,12}(\.\d{1,6})?$/;
/** An IMF-fixdate HTTP date: `Wed, 21 Oct 2026 07:28:00 GMT`. */
const HTTP_DATE_VALUE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
/** A rate-limit count: digits only. */
const COUNT_VALUE = /^\d{1,20}$/;
/** A rate-limit reset: digits (seconds or an epoch), or a duration such as `1s`, `6m0s`, `20ms`. */
const RESET_VALUE = /^(\d{1,20}|(\d{1,12}(\.\d{1,6})?(h|ms|m|s)){1,4})$/;
/** A request id: letters, digits and `._:-` only. */
const REQUEST_ID_VALUE = /^[A-Za-z0-9._:-]{1,128}$/;
/**
 * The shape each kept header's value must have. Anything else (prose, markup,
 * quotes, control characters, a provider echoing request text) is dropped, never
 * cut into something that looks safe. Checked on the whole trimmed value, so a
 * value longer than `MAX_HEADER_CHARS` is dropped, not truncated.
 */
const HEADER_VALUE: Readonly<Record<string, (v: string) => boolean>> = {
  "retry-after": (v) => NUMBER_VALUE.test(v) || HTTP_DATE_VALUE.test(v),
  "retry-after-ms": (v) => NUMBER_VALUE.test(v),
  "x-ratelimit-limit-requests": (v) => COUNT_VALUE.test(v),
  "x-ratelimit-remaining-requests": (v) => COUNT_VALUE.test(v),
  "x-ratelimit-reset-requests": (v) => RESET_VALUE.test(v),
  "x-ratelimit-limit-tokens": (v) => COUNT_VALUE.test(v),
  "x-ratelimit-remaining-tokens": (v) => COUNT_VALUE.test(v),
  "x-ratelimit-reset-tokens": (v) => RESET_VALUE.test(v),
  "x-request-id": (v) => REQUEST_ID_VALUE.test(v),
  "cf-ray": (v) => REQUEST_ID_VALUE.test(v),
};

/** The value of kept header `name` if it has its header's shape, else undefined. */
const keptValue = (name: string, raw: string): string | undefined => {
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_HEADER_CHARS) return undefined;
  return HEADER_VALUE[name]?.(value) === true ? value : undefined;
};
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
    if (!tracked) return res;
    if (res.ok) {
      const settle = costs.get(tag);
      if (!settle || !res.body) {
        settle?.(undefined);
        return res;
      }
      // Tee: the SDK reads one branch untouched, the tap reads `usage.cost` from the other.
      // The tap's reader is kept per tag, so dispose (or settling) cancels it and the tee
      // stops buffering for a branch nobody reads.
      const [forCaller, forTap] = res.body.tee();
      const reader = forTap.getReader() as unknown as BodyReader;
      costReaders.set(tag, reader);
      void readCost(reader).then(settle, () => settle(undefined));
      // Marks the end of the caller's branch (its flush runs before the caller sees `done`).
      const watched = forCaller.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          flush: () => {
            if (costs.has(tag)) costBodyEnded.add(tag);
          },
        }),
      );
      return new Response(watched, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }
    const kept: Record<string, string> = {};
    let retryAfterMalformed = false;
    for (const name of KEPT_HEADERS) {
      const v = res.headers.get(name);
      if (v === null) continue;
      const value = keptValue(name, v);
      if (value !== undefined) kept[name] = value;
      else if (name === "retry-after" || name === "retry-after-ms") retryAfterMalformed = true;
    }
    const record: AttemptResponse = {
      status: res.status,
      headers: kept,
      ...(retryAfterMalformed ? { retryAfterMalformed: true as const } : {}),
    };
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
  /** Empty when the tap is off (`fetch` could not be patched): send nothing. */
  header: Record<string, string>;
  take(): AttemptResponse | undefined;
  /**
   * The provider-billed `usage.cost` of a 2xx response (attempts opened with
   * `{ cost: true }`). Once the caller has read the body to its end, this waits for the
   * tap's reader of the same (local) bytes, with no time limit beyond the reader's own
   * deadline. Before that (a body still open), undefined when none arrives within `settleMs`.
   */
  cost(settleMs?: number): Promise<number | undefined>;
  dispose(): void;
}

const COST_SETTLE_MS = 1_000;

export function startAttemptTap(opts: { cost?: boolean } = {}): AttemptTap {
  // Off when the global cannot be patched, or when it is no longer this tap.
  if (!install() || globalThis.fetch !== tappedFetch)
    return {
      header: {},
      take: () => undefined,
      cost: async () => undefined,
      dispose: () => {},
    };
  const tag = newTag();
  live.add(tag);
  let billed: Promise<number | undefined> = Promise.resolve(undefined);
  if (opts.cost) {
    billed = new Promise((resolve) => {
      costs.set(tag, (c) => {
        costs.delete(tag);
        costBodyEnded.delete(tag);
        const reader = costReaders.get(tag);
        costReaders.delete(tag);
        void reader?.cancel().catch(() => {});
        resolve(c);
      });
    });
  }
  return {
    header: { [TAG_HEADER]: tag },
    take: () => records.get(tag),
    cost: async (settleMs = COST_SETTLE_MS) => {
      // The body ended: the whole of it is buffered for the tap's reader, so the result is
      // deterministic (no race with a timer under load).
      if (costBodyEnded.has(tag)) return billed;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>((r) => {
        timer = setTimeout(() => r(undefined), settleMs);
      });
      try {
        return await Promise.race([billed, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    dispose: () => {
      live.delete(tag);
      records.delete(tag);
      costs.get(tag)?.(undefined); // also cancels the tag's body reader
      costBodyEnded.delete(tag);
      const reader = costReaders.get(tag);
      costReaders.delete(tag);
      void reader?.cancel().catch(() => {});
    },
  };
}

/** @internal Test seam: attempts still holding tap state (0 when idle). */
export const liveAttemptTaps = (): number =>
  live.size + costs.size + costReaders.size + costBodyEnded.size;

/** @internal Test seam: whether the process-wide `fetch` tap is installed. */
export const attemptTapInstalled = (): boolean => installed;

const costFromObject = (o: unknown): number | undefined => {
  const usage = (o as { usage?: { cost?: unknown } } | null)?.usage;
  return typeof usage?.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
    ? usage.cost
    : undefined;
};

/**
 * `usage.cost` from an SSE or JSON 2xx body, read to the end or until `COST_BODY_TIMEOUT_MS`
 * (the last value wins). Lines are scanned from a moving offset and the buffer is compacted
 * once per chunk; a line over `MAX_COST_LINE_CHARS` is dropped unread; only lines that mention
 * `"cost"` are parsed. @internal (exported for tests).
 */
export async function readCost(
  reader: BodyReader,
  timeoutMs = COST_BODY_TIMEOUT_MS,
): Promise<number | undefined> {
  const decoder = new TextDecoder();
  let buf = "";
  let skipping = false; // inside an oversized line: drop until its newline
  let found: number | undefined;
  const scan = (line: string): void => {
    if (!line.includes('"cost"')) return;
    const t = line.trim();
    const json = t.startsWith("data:") ? t.slice(5).trim() : t;
    if (!json.startsWith("{")) return;
    try {
      found = costFromObject(JSON.parse(json)) ?? found;
    } catch {
      /* partial or non-JSON line */
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), timeoutMs);
  });
  try {
    for (;;) {
      const step = await Promise.race([reader.read(), deadline]);
      if (step === "timeout" || step.done || !step.value) break;
      buf += decoder.decode(step.value, { stream: true });
      let start = 0;
      let nl = buf.indexOf("\n", start);
      while (nl >= 0) {
        if (skipping) skipping = false;
        else if (nl - start <= MAX_COST_LINE_CHARS) scan(buf.slice(start, nl));
        start = nl + 1;
        nl = buf.indexOf("\n", start);
      }
      buf = buf.slice(start); // compact once per chunk
      if (buf.length > MAX_COST_LINE_CHARS) {
        buf = "";
        skipping = true;
      }
    }
    if (!skipping) scan(buf);
  } catch {
    /* aborted or cancelled: whatever was found stands */
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  return found;
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
  // A present but malformed value was dropped from `headers`; it still must not read as "no wait".
  const wait =
    retryAfterFromHeaders(res.headers) ??
    (res.retryAfterMalformed ? Number.MAX_SAFE_INTEGER : undefined);
  if (wait !== undefined) raw.retryAfterMs = wait;
  return raw;
}

/** Test seam: whether the next attempt would be tapped (installed and still the global). */
export const attemptTapActive = (): boolean => installed && globalThis.fetch === tappedFetch;
