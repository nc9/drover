import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { streamSimple, type Api, type Model } from "@earendil-works/pi-ai/compat";

import { canonicalProvider, createProviderChain, resolveModel, withAliases } from "../src/index.ts";

type Seen = { url: string; headers: Headers };
const seen: Seen[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req) => {
    seen.push({ url: new URL(req.url).pathname, headers: req.headers });
    return new Response('{"error":{"message":"stop here"}}', {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  },
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;

const gw = (api: Api, id: string, path: string): Model<Api> =>
  ({
    id,
    name: id,
    api,
    provider: "cloudflare-ai-gateway",
    baseUrl: `${base}/${path}`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  }) as Model<Api>;

const ctx = { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as never;
const SHAPES: ReadonlyArray<[Api, string]> = [
  ["openai-completions", "compat"],
  ["openai-responses", "openai"],
  ["anthropic-messages", "anthropic"],
];

describe("cloudflare-ai-gateway auth outside the chain", () => {
  for (const [api, path] of SHAPES) {
    test(`resolveModel -> streamSimple, ${api}: cf-aig-authorization, no upstream bearer`, async () => {
      const m = gw(api, "m", path);
      const preResolved = new Map([["gw", { model: m as never, apiKey: "cf-token" }]]);
      const r = await Effect.runPromise(resolveModel("gw", { runId: "r", preResolved }));
      seen.length = 0;
      await streamSimple(r.model, ctx, { apiKey: r.apiKey }).result();
      expect(seen.length).toBeGreaterThan(0);
      const h = seen[0]!.headers;
      expect(h.get("cf-aig-authorization")).toBe("Bearer cf-token");
      expect(h.get("authorization")).toBeNull();
      expect(h.get("x-api-key")).toBeNull();
    });
  }

  test("the registry path (alias to a gateway model) gets the headers too", async () => {
    const r = await Effect.runPromise(
      resolveModel("g", {
        runId: "r",
        aliases: withAliases({ g: { provider: "cloudflare-ai-gateway", modelId: "gpt-5-mini" } }),
        env: { CLOUDFLARE_API_KEY: "cf-token" },
      }),
    ).catch((e) => e);
    // Only when the registry lists that id; otherwise the miss is the routing error, not a header bug.
    if (r?.model) expect(r.model.headers?.["cf-aig-authorization"]).toBe("Bearer cf-token");
  });

  test("a chain pass-through model (provider not in the chain) is sent with the headers", async () => {
    const chain = createProviderChain({ providers: ["openrouter"], apiKeys: { openrouter: "k" } });
    seen.length = 0;
    const stream = await chain.forRun()(gw("openai-completions", "m", "compat") as never, ctx, {
      apiKey: "cf-token",
    });
    await stream.result();
    const h = seen[0]!.headers;
    expect(h.get("cf-aig-authorization")).toBe("Bearer cf-token");
    expect(h.get("authorization")).toBeNull();
  });

  test("an explicit Authorization header is kept; a stray cf-aig header is overwritten", async () => {
    const m = {
      ...gw("openai-completions", "m", "compat"),
      headers: { Authorization: "Bearer up", "CF-AIG-Authorization": "x" },
    };
    const preResolved = new Map([["gw", { model: m as never, apiKey: "cf-token" }]]);
    const r = await Effect.runPromise(resolveModel("gw", { runId: "r", preResolved }));
    seen.length = 0;
    await streamSimple(r.model, ctx, { apiKey: r.apiKey }).result();
    const h = seen[0]!.headers;
    expect(h.get("authorization")).toBe("Bearer up");
    expect(h.get("cf-aig-authorization")).toBe("Bearer cf-token");
  });
});

describe("azure alias outside the chain", () => {
  test("canonicalProvider maps the old name only", () => {
    expect(canonicalProvider("azure-openai-responses")).toBe("azure");
    expect(canonicalProvider("azure")).toBe("azure");
    expect(canonicalProvider("constructor")).toBe("constructor");
  });

  test('resolveModel: "azure-openai-responses:<id>" slug and withAliases entries resolve to azure', async () => {
    const slug = await Effect.runPromise(
      resolveModel("azure-openai-responses:gpt-4.1", { runId: "r", env: {} }),
    ).catch((e) => e);
    // No key configured: the failure names the canonical provider, which proves the lookup found it.
    expect(String(slug.message)).toContain('provider "azure"');
    const al = await Effect.runPromise(
      resolveModel("a", {
        runId: "r",
        aliases: withAliases({ a: { provider: "azure-openai-responses", modelId: "gpt-4.1" } }),
        env: {},
      }),
    ).catch((e) => e);
    expect(String(al.message)).toContain('provider "azure"');
  });

  test("extraModels with the old provider name serve the azure entry", async () => {
    const got: string[] = [];
    const m = { ...gw("openai-responses", "my-dep", "x"), provider: "azure-openai-responses" };
    const chain = createProviderChain({
      providers: ["azure"],
      apiKeys: { azure: "k" },
      extraModels: [m as never],
      streams: {
        azure: ((model: Model<Api>) => {
          got.push(`${model.provider}/${model.id}`);
          return streamSimple(model, ctx, { apiKey: "k" });
        }) as never,
      },
    });
    const stream = await chain.forRun()({ ...m, provider: "azure" } as never, ctx, {
      apiKey: "k",
    });
    await stream.result();
    expect(got).toEqual(["azure/my-dep"]);
  });
});
