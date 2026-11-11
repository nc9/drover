/**
 * Structured provider errors over real HTTP: local servers answer through pi-ai's real OpenAI
 * client, so what is asserted is what production sees (status, body code, headers), not message text.
 */
import { describe, expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@mariozechner/pi-ai";

import {
  createProviderChain,
  retryAfterFromHeaders,
  type ProviderFailoverNotice,
} from "../src/index.ts";
import { startAttemptTap } from "../src/provider-chain/response-tap.ts";

void createAssistantMessageEventStream;

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
/** pi-ai provider names pointed at local servers: `or` is "openrouter", `gw` the gateway, `second` a second OpenRouter-shaped one. */
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

function server(respond: (n: number, req: Request) => Response) {
  const seen: Request[] = [];
  const s = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push(req);
      return respond(seen.length, req);
    },
  });
  return { seen, base: `http://127.0.0.1:${s.port}`, stop: () => s.stop(true) };
}

async function run(chain: ReturnType<typeof createProviderChain>) {
  const notices: ProviderFailoverNotice[] = [];
  const stream = await chain.forRun((n) => notices.push(n))(canonical, ctx);
  for await (const _ of stream) void _;
  return { result: (await stream.result()) as AssistantMessage, notices };
}

const REGION = "unsupported_country_region_territory";

describe("response tap: structured errors over the real transport", () => {
  test("a 403 with the structured region code is region_refused; the text is not in the message by default", async () => {
    const a = server(() =>
      json(403, {
        error: {
          message: "Country, region, or territory not supported: SECRET-PROMPT-TEXT",
          code: REGION,
        },
      }),
    );
    const b = server(() => ok());
    try {
      const chain = chainTo({
        openrouter: `${a.base}/v1`,
        "cloudflare-ai-gateway": `${b.base}/v1`,
      });
      const { result, notices } = await run(chain);
      expect(result.stopReason).toBe("stop");
      expect(notices).toEqual([
        {
          action: "failover",
          from: "openrouter",
          to: "cloudflare-ai-gateway",
          failureClass: "region_refused",
          status: 403,
          code: REGION,
        },
      ]);
      expect(JSON.stringify(notices)).not.toContain("SECRET");
      expect(a.seen).toHaveLength(1); // never retried in place
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  test("both fail: the message carries class/status/code, not provider text; diagnostics carry the fields; opt-in adds text", async () => {
    const a = server(() =>
      json(
        402,
        { error: { message: "needs credits: SECRET-PROMPT-TEXT" } },
        { "x-request-id": "req-1", "set-cookie": "s=1" },
      ),
    );
    const b = server(() =>
      json(403, { error: { message: "nope SECRET-PROMPT-TEXT", code: REGION } }),
    );
    const urls = { openrouter: `${a.base}/v1`, "cloudflare-ai-gateway": `${b.base}/v1` };
    try {
      const { result } = await run(chainTo(urls));
      expect(result.errorMessage).toBe(
        `all providers failed: openrouter: credits_exhausted (402) | cloudflare-ai-gateway: region_refused (403 ${REGION})`,
      );
      expect(result.errorMessage).not.toContain("SECRET");
      const d = result.diagnostics!.map((x) => x.details);
      expect(d[0]).toMatchObject({
        provider: "openrouter",
        failureClass: "credits_exhausted",
        status: 402,
        headers: { "x-request-id": "req-1" },
      });
      expect(JSON.stringify(d)).not.toContain("set-cookie");
      expect(JSON.stringify(d)).not.toContain("SECRET");
      expect(d[1]).toMatchObject({ failureClass: "region_refused", status: 403, code: REGION });

      const withText = await run(chainTo(urls, { includeProviderText: true }));
      expect(withText.result.errorMessage).toContain("SECRET-PROMPT-TEXT");
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  test("message text that echoes credit/region tokens classifies nothing; structured limit_source does", async () => {
    const echo = server(() =>
      json(403, {
        error: {
          message: `prompt said insufficient_quota openrouter_key_limit ${REGION}`,
          code: "invalid_prompt",
        },
      }),
    );
    const limit = server(() =>
      json(403, {
        error: {
          message: "Key limit exceeded",
          metadata: { limit_source: "openrouter_key_limit" },
        },
      }),
    );
    try {
      const e = await run(chainTo({ openrouter: `${echo.base}/v1` }));
      expect(e.notices[0]).toMatchObject({
        action: "exhausted",
        // A 403 with no known structured code is "forbidden" (not benched), never credits/region.
        failureClass: "forbidden",
        status: 403,
      });
      const l = await run(chainTo({ openrouter: `${limit.base}/v1` }));
      expect(l.notices[0]).toMatchObject({ failureClass: "credits_exhausted", status: 403 });
    } finally {
      await echo.stop();
      await limit.stop();
    }
  });

  test("a real Retry-After header is honoured (retry-after-ms wins, seconds otherwise)", async () => {
    const a = server((n) =>
      n === 1 ? json(429, { error: { message: "slow down" } }, { "retry-after": "2" }) : ok(),
    );
    try {
      const sleeps: number[] = [];
      const chain = chainTo(
        { openrouter: `${a.base}/v1` },
        { sleep: async (ms: number) => void sleeps.push(ms) },
      );
      const { result, notices } = await run(chain);
      expect(sleeps).toEqual([2000]);
      expect(result.stopReason).toBe("stop");
      expect(notices).toEqual([
        {
          action: "retry",
          from: "openrouter",
          to: null,
          failureClass: "rate_limited",
          status: 429,
          waitMs: 2000,
        },
      ]);
    } finally {
      await a.stop();
    }
  });

  test("the attempt tag never reaches the provider, and successful calls are untouched", async () => {
    const a = server(() => ok());
    try {
      const { result } = await run(chainTo({ openrouter: `${a.base}/v1` }));
      expect(result.content).toEqual([{ type: "text", text: "ok" }]);
      expect([...a.seen[0]!.headers.keys()].some((h) => h.startsWith("x-drover"))).toBe(false);
    } finally {
      await a.stop();
    }
  });

  test("an unparseable error body still yields the status; a 5xx fails over", async () => {
    const a = server(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const b = server(() => ok());
    try {
      const chain = chainTo({ openrouter: `${a.base}/v1`, second: `${b.base}/v1` });
      const { notices } = await run(chain);
      expect(notices[0]).toMatchObject({
        failureClass: "provider_error",
        status: 502,
        to: "second",
      });
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  test("retryAfterFromHeaders", () => {
    expect(retryAfterFromHeaders({ "retry-after-ms": "250" })).toBe(250);
    expect(retryAfterFromHeaders({ "retry-after": "3" })).toBe(3000);
    expect(retryAfterFromHeaders({})).toBeUndefined();
    const future = new Date(Date.now() + 5_000).toUTCString();
    expect(retryAfterFromHeaders({ "retry-after": future })!).toBeGreaterThan(2_000);
  });

  test("a malformed Retry-After is never an immediate retry; it is beyond any cap", () => {
    for (const bad of ["foo 5", "5 foo", "-3", "NaN", "1e9", "Infinity"])
      expect(retryAfterFromHeaders({ "retry-after": bad })!).toBeGreaterThan(600_000);
    expect(retryAfterFromHeaders({ "retry-after": "999999999999" })!).toBeGreaterThan(600_000);
  });

  test("tags are UUIDs, are ignored after dispose, and a late response is not stored", async () => {
    const tap = startAttemptTap();
    const tag = Object.values(tap.header)[0]!;
    expect(tag).toMatch(/^[0-9a-f-]{36}$/);
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('{"error":{"code":"x"}}', { status: 403 }),
    });
    try {
      tap.dispose();
      await fetch(`http://127.0.0.1:${server.port}/`, { headers: tap.header });
      await new Promise((r) => setTimeout(r, 50));
      expect(tap.take()).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("kept header values are capped at 128 chars", async () => {
    const tap = startAttemptTap();
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("{}", { status: 500, headers: { "x-request-id": "a".repeat(5000) } }),
    });
    try {
      await fetch(`http://127.0.0.1:${server.port}/`, { headers: tap.header });
      expect(tap.take()!.headers["x-request-id"]).toHaveLength(128);
    } finally {
      tap.dispose();
      server.stop(true);
    }
  });
});
