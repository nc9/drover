/**
 * Provider-billed cost.
 *
 * pi-ai (`openai-completions`) reads token counts from the final usage chunk
 * and prices them from the model's list rates (`Model.cost`); it DROPS the
 * provider's own `usage.cost`. For OpenRouter that field is the amount actually
 * billed (routing, discounts, cache pricing and BYOK all folded in), and it is
 * only sent when the request carries `usage: { include: true }`.
 * Neither pi's events nor its options expose the raw chunk, so there is no
 * pure-`streamFn` way to read it.
 *
 * `withProviderCost(base)` closes the gap:
 *  1. adds `usage: { include: true }` to the request body (via `onPayload`,
 *     composed with any `onPayload` the caller passed);
 *  2. tags the call with a unique header; a process-wide `fetch` wrapper
 *     (installed once, pass-through for untagged requests) strips the header,
 *     tees the response body, and reads `usage.cost` from the SSE stream (or a
 *     plain JSON body);
 *  3. on the terminal `done` event, replaces `message.usage.cost.total` with the
 *     billed figure. The harness sums `usage.cost.total` into `Usage.costUsd`,
 *     so `quota.maxCostUsd` then runs on billed cost.
 *
 * Only `cost.total` is replaced; the per-component list-price fields
 * (`cost.input`, ...) are left as computed by pi. When the provider sends no
 * cost (non-OpenRouter, errors) the message is passed through unchanged.
 *
 * Relies on the OpenAI SDK resolving `globalThis.fetch` when a client is
 * created (true for openai >= 4, which pi-ai uses), so a host that injects its
 * own fetch into the client is not covered.
 */
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, streamSimple } from "@mariozechner/pi-ai";
import type { AssistantMessageEvent } from "@mariozechner/pi-ai";

type FetchInput = Parameters<typeof fetch>[0];

const TAG_HEADER = "x-drover-cost-tag";
/** How long to wait for the tee reader after the stream has ended. */
const SETTLE_MS = 1_000;

type Pending = { promise: Promise<number | undefined>; resolve: (c: number | undefined) => void };
const pending = new Map<string, Pending>();

const costFromObject = (o: unknown): number | undefined => {
  const usage = (o as { usage?: { cost?: unknown } } | null)?.usage;
  return typeof usage?.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : undefined;
};

/** Pull `usage.cost` out of an SSE or JSON body, reading it to the end. */
const readCost = async (body: ReadableStream<Uint8Array>): Promise<number | undefined> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let found: number | undefined;
  const scan = (line: string): void => {
    const t = line.trim();
    const json = t.startsWith("data:") ? t.slice(5).trim() : t;
    if (json === "" || json === "[DONE]" || !json.startsWith("{")) return;
    try {
      found = costFromObject(JSON.parse(json)) ?? found;
    } catch {
      /* partial / non-JSON line */
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        scan(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    }
    scan(buf);
  } catch {
    /* aborted: whatever was found stands */
  }
  return found;
};

const headerOf = (input: FetchInput, init?: RequestInit): string | null => {
  if (init?.headers) return new Headers(init.headers).get(TAG_HEADER);
  if (typeof Request !== "undefined" && input instanceof Request)
    return input.headers.get(TAG_HEADER);
  return null;
};

let installed = false;
const installFetchTap = (): void => {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch;
  const tapped = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const tag = headerOf(input, init);
    if (!tag) return original(input, init);
    const entry = pending.get(tag);
    // Strip our header before the request leaves the process.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.delete(TAG_HEADER);
    const res = await original(input instanceof Request ? new Request(input, { headers }) : input, {
      ...init,
      headers,
    });
    if (!entry || !res.body) {
      entry?.resolve(undefined);
      return res;
    }
    const [forCaller, forTap] = res.body.tee();
    void readCost(forTap).then(entry.resolve);
    return new Response(forCaller, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
  globalThis.fetch = Object.assign(tapped, original) as typeof fetch;
};

const newTag = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

const settled = async (p: Pending): Promise<number | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((r) => {
    timer = setTimeout(() => r(undefined), SETTLE_MS);
  });
  try {
    return await Promise.race([p.promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Wrap `base` (default: pi's `streamSimple`) so `Usage.costUsd` is the
 * provider-billed cost. Pass the result as `HarnessDeps.streamFn`.
 */
export const withProviderCost = (base: StreamFn = streamSimple as StreamFn): StreamFn => {
  installFetchTap();
  return async (model, context, options) => {
    const tag = newTag();
    let resolve!: (c: number | undefined) => void;
    const promise = new Promise<number | undefined>((r) => {
      resolve = r;
    });
    const entry: Pending = { promise, resolve };
    pending.set(tag, entry);

    const callerPayload = options?.onPayload;
    const stream = await base(model, context, {
      ...options,
      headers: { ...options?.headers, [TAG_HEADER]: tag },
      onPayload: async (payload, m) => {
        const patched = (await callerPayload?.(payload, m)) ?? payload;
        const body = patched as Record<string, unknown>;
        const prior = body.usage as Record<string, unknown> | undefined;
        return { ...body, usage: { ...prior, include: true } };
      },
    });

    const out = createAssistantMessageEventStream();
    void (async () => {
      try {
        for await (const e of stream) {
          if (e.type === "done") {
            const billed = await settled(entry);
            if (billed !== undefined) {
              const message = {
                ...e.message,
                usage: { ...e.message.usage, cost: { ...e.message.usage.cost, total: billed } },
              };
              out.push({ ...e, message } as AssistantMessageEvent);
              continue;
            }
          }
          out.push(e);
        }
      } finally {
        pending.delete(tag);
        entry.resolve(undefined);
        out.end();
      }
    })();
    return out;
  };
};
