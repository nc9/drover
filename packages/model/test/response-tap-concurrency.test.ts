/**
 * Concurrent failing chain calls over the real HTTP transport (#91, #18 AC2 and AC4): every
 * attempt has its own tap tag, so each call's error and failover records carry only its own
 * status, code and Retry-After, never another in-flight call's.
 */
import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Context } from "@mariozechner/pi-ai";

import { createProviderChain, type ProviderFailoverNotice } from "../src/index.ts";
import { liveAttemptTaps } from "../src/provider-chain/response-tap.ts";

const piModel = (provider: string, id: string, baseUrl: string) =>
  ({
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }) as never;

const chainTo = (urls: Record<string, string>, extra: object = {}) =>
  createProviderChain({
    providers: Object.keys(urls),
    extraModels: Object.entries(urls).flatMap(([p, base]) => [
      piModel(p, "openai/gpt-5-mini", base),
      piModel(p, "gpt-5-mini", base),
    ]),
    apiKeys: Object.fromEntries(Object.keys(urls).map((p) => [p, "k"])),
    env: {},
    ...extra,
  });

const canonical = {
  id: "openai/gpt-5-mini",
  name: "x",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1,
  maxTokens: 1,
} as never;
const ctx: Context = {
  systemPrompt: "s",
  messages: [{ role: "user", content: "hi", timestamp: 0 }],
} as never;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const ok = () =>
  new Response(
    [
      `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

/**
 * A JSON error whose body arrives in two parts: the head now, the rest once `rest` resolves. Every
 * call's tap is then holding an unread error body at the same time, so their records overlap.
 */
const splitJson = (
  status: number,
  body: unknown,
  headers: Record<string, string>,
  rest: Promise<void>,
) => {
  const text = JSON.stringify(body);
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(enc.encode(text.slice(0, 5)));
        await rest;
        c.enqueue(enc.encode(text.slice(5)));
        c.close();
      },
    }),
    { status, headers: { "content-type": "application/json", ...headers } },
  );
};

/** A local server bound to the address the chain calls (see #78: never Bun's dual-stack default). */
function server(respond: (n: number, req: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen.push(req);
      return respond(seen.length, req);
    },
  });
  return { seen, base: `http://127.0.0.1:${s.port}`, stop: () => s.stop(true) };
}

/** Holds every arriving request until `size` have arrived, so their attempts are in flight at once. */
function barrier(size: number) {
  let arrived = 0;
  let open!: () => void;
  const all = new Promise<void>((r) => (open = r));
  return async (): Promise<void> => {
    arrived += 1;
    if (arrived >= size) open();
    await all;
  };
}

async function run(chain: ReturnType<typeof createProviderChain>) {
  const notices: ProviderFailoverNotice[] = [];
  const stream = await chain.forRun((n) => notices.push(n))(canonical, ctx);
  for await (const _ of stream) void _;
  return { result: (await stream.result()) as AssistantMessage, notices };
}

describe("concurrent failing calls keep their own tap records (#91)", () => {
  test("a 429 with Retry-After and a 503 in flight at once: each call reports only its own status, code and wait", async () => {
    const PAIRS = 10;
    // Every first request (both servers, every pair) waits until all of them have arrived.
    const together = barrier(PAIRS * 2 + 1);
    // Every first error body finishes only after all of them have started arriving.
    let releaseBodies!: () => void;
    const bodiesDone = new Promise<void>((r) => (releaseBodies = r));
    void together().then(() => setTimeout(releaseBodies, 100)); // counts as one arrival

    // A 429 call retries in place once; only its first request joins the barrier.
    let limitedFirsts = 0;
    const limited = server(async () => {
      const headers = { "retry-after": "7", "x-request-id": "req-limited" };
      const body = { error: { message: "slow down" } };
      if (limitedFirsts++ >= PAIRS) return json(429, body, headers); // the in-place retry
      await together();
      return splitJson(429, body, headers, bodiesDone);
    });
    const down = server(async () => {
      await together();
      // A known code on the 503: kept in its record, and it would turn a 429 into
      // credits_exhausted if it ever leaked into the other call's record.
      return splitJson(
        503,
        { error: { message: "overloaded", code: "insufficient_quota" } },
        { "x-request-id": "req-down" },
        bodiesDone,
      );
    });
    try {
      const before = liveAttemptTaps();
      const sleeps: number[] = [];
      const runs = await Promise.all(
        Array.from({ length: PAIRS }, () => [
          run(
            chainTo(
              { openrouter: `${limited.base}/v1` },
              // The in-place retry after Retry-After: recorded, not waited, and the barrier
              // has already opened, so the retry answers at once.
              { sleep: async (ms: number) => void sleeps.push(ms) },
            ),
          ).then((r) => ({ kind: "limited" as const, ...r })),
          run(chainTo({ openrouter: `${down.base}/v1` })).then((r) => ({
            kind: "down" as const,
            ...r,
          })),
        ]).flat(),
      );
      expect(sleeps).toEqual(Array(PAIRS).fill(7000));

      for (const r of runs) {
        expect(r.result.stopReason).toBe("error");
        const own =
          r.kind === "limited"
            ? {
                status: 429,
                code: undefined,
                failureClass: "rate_limited",
                requestId: "req-limited",
              }
            : {
                status: 503,
                code: "insufficient_quota",
                failureClass: "provider_error",
                requestId: "req-down",
              };

        // Failover records: only this call's status and code; only the 429 call waited.
        expect(r.notices.length).toBeGreaterThan(0);
        for (const n of r.notices) {
          expect(n).toMatchObject({ status: own.status, failureClass: own.failureClass });
          expect(n.code).toBe(own.code);
          if (r.kind === "down") expect(n.waitMs).toBeUndefined();
        }
        if (r.kind === "limited") {
          expect(r.notices[0]).toMatchObject({ action: "retry", waitMs: 7000 });
        }

        // The final error: message and diagnostics carry this call's fields only.
        expect(r.result.errorMessage).toBe(
          `all providers failed: openrouter: ${own.failureClass} (${own.status}${own.code ? ` ${own.code}` : ""})`,
        );
        const details = r.result.diagnostics!.map((d) => d.details as Record<string, unknown>);
        expect(details.length).toBeGreaterThan(0);
        for (const d of details) {
          expect(d).toMatchObject({ status: own.status, failureClass: own.failureClass });
          expect(d.code).toBe(own.code);
          const headers = (d.headers ?? {}) as Record<string, string>;
          expect(headers["x-request-id"]).toBe(own.requestId);
          if (r.kind === "limited") expect(headers["retry-after"]).toBe("7");
          else expect(headers["retry-after"]).toBeUndefined();
        }
      }
      // Every attempt's tap state was released.
      expect(liveAttemptTaps()).toBe(before);
    } finally {
      await limited.stop();
      await down.stop();
    }
  });

  test("a 403 with an invalid_api_key body classifies as key_refused over real HTTP", async () => {
    const a = server(() =>
      json(403, { error: { message: "Invalid API key provided", code: "invalid_api_key" } }),
    );
    const b = server(() => ok());
    try {
      const { result, notices } = await run(
        chainTo({ openrouter: `${a.base}/v1`, "cloudflare-ai-gateway": `${b.base}/v1` }),
      );
      expect(result.stopReason).toBe("stop");
      expect(notices).toEqual([
        {
          action: "failover",
          from: "openrouter",
          to: "cloudflare-ai-gateway",
          failureClass: "key_refused",
          status: 403,
          code: "invalid_api_key",
          benched: true, // a refused key skips the provider for the run
        },
      ]);
      expect(a.seen).toHaveLength(1); // never retried in place
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});
