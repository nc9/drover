/** Billed-cost reading in the shared response tap (#4 round 2): bounded, cancellable, host-checked. */
import { describe, expect, test } from "bun:test";

import { isOpenRouter } from "../src/provider-chain/provider-cost.ts";
import { liveAttemptTaps, readCost, startAttemptTap } from "../src/provider-chain/response-tap.ts";

const enc = new TextEncoder();
const streamOf = (chunks: string[], keepOpen = false) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      if (!keepOpen) c.close();
    },
  }).getReader();

describe("readCost", () => {
  test("reads the last usage.cost; only lines mentioning cost are parsed", async () => {
    const cost = await readCost(
      streamOf([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":1,"co',
        'st":0.0123}}\n\ndata: [DONE]\n\n',
      ]),
    );
    expect(cost).toBe(0.0123);
  });

  test("an oversized line is dropped unread, in one chunk or split across many", async () => {
    const big = `data: {"pad":"${"x".repeat(100 * 1024)}","usage":{"cost":9}}\n`;
    // Whole oversized line in one chunk, then a normal usage line.
    expect(await readCost(streamOf([big, 'data: {"usage":{"cost":0.5}}\n']))).toBe(0.5);
    // The same line split into 1 KB chunks (never complete in the buffer at once).
    const split = big.match(/[\s\S]{1,1024}/g)!;
    expect(await readCost(streamOf([...split, 'data: {"usage":{"cost":0.25}}\n']))).toBe(0.25);
    // A 5 MB body with no newline at all: nothing found, nothing buffered beyond the cap.
    expect(await readCost(streamOf(["x".repeat(5 * 1024 * 1024)]))).toBeUndefined();
  });

  test("an overall deadline ends a body that never finishes", async () => {
    const t0 = Date.now();
    expect(await readCost(streamOf(['data: {"x":1}\n'], true), 50)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("tap reader lifetime", () => {
  test("dispose cancels the tag's body reader and settles the cost at once", async () => {
    let open = true;
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode('data: {"choices":[]}\n\n')); // and never closes
            },
            cancel() {
              open = false;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    try {
      const tap = startAttemptTap({ cost: true });
      const res = await fetch(`http://127.0.0.1:${server.port}/`, { headers: tap.header });
      expect(res.ok).toBe(true);
      const reading = tap.cost(10_000);
      const t0 = Date.now();
      tap.dispose();
      expect(await reading).toBeUndefined();
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(liveAttemptTaps()).toBe(0);
      await res.body?.cancel(); // the caller's branch too: the source is released
      await new Promise((r) => setTimeout(r, 50));
      expect(open).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

describe("isOpenRouter", () => {
  test("by provider name or the base URL's parsed host; look-alike hosts and paths are not", () => {
    expect(isOpenRouter({ provider: "openrouter" })).toBe(true);
    expect(isOpenRouter({ baseUrl: "https://openrouter.ai/api/v1" })).toBe(true);
    expect(isOpenRouter({ baseUrl: "https://eu.openrouter.ai/api/v1" })).toBe(true);
    expect(isOpenRouter({ baseUrl: "https://openrouter.ai.evil.test/v1" })).toBe(false);
    expect(isOpenRouter({ baseUrl: "https://evil.test/openrouter.ai/v1" })).toBe(false);
    expect(isOpenRouter({ baseUrl: "https://notopenrouter.ai/v1" })).toBe(false);
    expect(isOpenRouter({ baseUrl: "not a url openrouter.ai" })).toBe(false);
    expect(isOpenRouter({})).toBe(false);
  });
});
