import { describe, expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
} from "@mariozechner/pi-ai";

import {
  DEFAULT_FAILOVER_POLICY,
  classifyFailure,
  cloudflareAiGateway,
  createProviderChain,
  openRouter,
  parseRetryAfterMs,
  type ChainStreamFn,
  type ProviderFailoverNotice,
  type ProviderSpec,
} from "../src/index.ts";

// ---- fakes ----------------------------------------------------------------

type Script =
  | { kind: "ok"; text?: string }
  | { kind: "error"; message: string }
  | { kind: "throw"; error: Error }
  | { kind: "empty" }
  | { kind: "partial-then-error"; message: string }
  | { kind: "hang" };

const msg = (provider: string, over: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider,
  model: "m",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
  ...over,
});

/** A provider whose stream plays the next script entry per call. */
function fake(name: string, scripts: Script[], map: (id: string) => string | null = (id) => id) {
  const calls: { model: string; apiKey?: string }[] = [];
  const stream: ChainStreamFn = (model, _ctx, options) => {
    const s = scripts[Math.min(calls.length, scripts.length - 1)]!;
    calls.push({ model: model.id, ...(options?.apiKey ? { apiKey: options.apiKey } : {}) });
    if (s.kind === "throw") throw s.error;
    const out = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const p = msg(name, { model: model.id });
      if (s.kind === "ok") {
        const text = s.text ?? `from ${name}`;
        const done = msg(name, {
          model: model.id,
          content: [{ type: "text", text }],
          usage: { ...p.usage, input: 10, output: 5, totalTokens: 15 },
        });
        out.push({ type: "start", partial: p });
        out.push({ type: "text_start", contentIndex: 0, partial: done });
        out.push({ type: "text_delta", contentIndex: 0, delta: text, partial: done });
        out.push({ type: "done", reason: "stop", message: done });
        out.end();
      } else if (s.kind === "error") {
        out.push({ type: "start", partial: p });
        out.push({
          type: "error",
          reason: "error",
          error: msg(name, { stopReason: "error", errorMessage: s.message }),
        });
        out.end();
      } else if (s.kind === "empty") {
        out.push({ type: "start", partial: p });
        out.push({ type: "done", reason: "stop", message: p });
        out.end();
      } else if (s.kind === "partial-then-error") {
        const part = msg(name, { content: [{ type: "text", text: "par" }] });
        out.push({ type: "start", partial: p });
        out.push({ type: "text_delta", contentIndex: 0, delta: "par", partial: part });
        out.push({
          type: "error",
          reason: "error",
          error: msg(name, { stopReason: "error", errorMessage: s.message }),
        });
        out.end();
      }
      // "hang": never pushes.
    });
    return out;
  };
  const spec: ProviderSpec = {
    name,
    mapModel: map,
    prepare: (canonical, mapped) => ({
      model: { ...canonical, id: mapped, provider: name },
      apiKey: `key-${name}`,
    }),
    stream,
  };
  return { spec, calls };
}

const canonical = {
  id: "openai/gpt-5-mini",
  name: "x",
  api: "openai-completions",
  provider: "openrouter",
} as never;
const ctx: Context = { messages: [] } as never;

async function run(
  chain: ReturnType<typeof createProviderChain>,
  opts?: { signal?: AbortSignal },
): Promise<{
  events: AssistantMessageEvent[];
  result: AssistantMessage;
  notices: ProviderFailoverNotice[];
}> {
  const notices: ProviderFailoverNotice[] = [];
  const stream = await chain.forRun((n) => notices.push(n))(canonical, ctx, opts);
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) events.push(e);
  return { events, result: await stream.result(), notices };
}

const noSleep = async (): Promise<void> => {};

// ---- classification ---------------------------------------------------------

describe("classifyFailure", () => {
  const cases: [string, string, string, number | null][] = [
    ["credits (402)", "402 This request requires more credits", "credits_exhausted", 402],
    [
      "openrouter key limit",
      "403 Key limit exceeded (openrouter_key_limit)",
      "credits_exhausted",
      403,
    ],
    [
      "insufficient quota",
      "429 You exceeded your current quota (insufficient_quota)",
      "credits_exhausted",
      429,
    ],
    ["key refused 401", "401 Invalid API key", "key_refused", 401],
    ["key refused 403", "403 Forbidden", "key_refused", 403],
    [
      "region",
      "403 request_forbidden: unsupported_country_region_territory",
      "region_refused",
      403,
    ],
    [
      "region by OpenAI's message (the SDK text drops the body code)",
      "403 Country, region, or territory not supported",
      "region_refused",
      403,
    ],
    ["rate limit", "429 Rate limit reached. Please try again in 2s", "rate_limited", 429],
    ["5xx", "502 Bad gateway", "provider_error", 502],
    ["503", "503 upstream overloaded", "provider_error", 503],
    ["504", "504 Gateway timeout", "timeout", 504],
    ["sdk timeout", "Request timed out.", "timeout", null],
    ["connection", "Connection error.", "timeout", null],
    ["malformed", "Unexpected token < in JSON at position 0", "malformed_response", null],
    ["model 404", "404 The model `x` does not exist", "model_unavailable", 404],
    ["context length", "400 context_length_exceeded: too many tokens", "invalid_request", 400],
    ["bad params", "422 Unprocessable", "invalid_request", 422],
    ["unknown", "something odd", "unknown", null],
  ];
  for (const [name, message, cls, status] of cases) {
    test(`${name} -> ${cls}`, () => {
      const f = classifyFailure("p", { message });
      expect(f.failureClass).toBe(cls as never);
      expect(f.status).toBe(status);
    });
  }

  test("a status number inside prose is not a status", () => {
    expect(classifyFailure("p", { message: "see page 402 of the doc" }).status).toBeNull();
  });

  test("region code is carried; free text codes are not", () => {
    expect(classifyFailure("p", { message: "403 unsupported_country_region_territory" }).code).toBe(
      "unsupported_country_region_territory",
    );
    expect(classifyFailure("p", { message: "500 totally_custom_code" }).code).toBeUndefined();
  });

  test("retry-after parsing", () => {
    expect(parseRetryAfterMs("Retry-After: 7")).toBe(7000);
    expect(parseRetryAfterMs("Please try again in 1.5s")).toBe(1500);
    expect(parseRetryAfterMs("try again in 250ms")).toBe(250);
    expect(parseRetryAfterMs("nothing here")).toBeUndefined();
    expect(parseRetryAfterMs("retry after 99999")).toBeUndefined();
  });

  test("policy table: only an invalid request ends the chain; region is never retried in place", () => {
    for (const [cls, entry] of Object.entries(DEFAULT_FAILOVER_POLICY)) {
      expect(entry.failover).toBe(cls !== "invalid_request");
      expect(entry.retrySame).toBe(cls === "rate_limited");
    }
  });
});

// ---- chain ------------------------------------------------------------------

describe("provider chain", () => {
  test("first provider answers: no notice, second untouched", async () => {
    const a = fake("a", [{ kind: "ok" }]);
    const b = fake("b", [{ kind: "ok" }]);
    const { result, notices } = await run(createProviderChain({ providers: [a.spec, b.spec] }));
    expect(result.content).toEqual([{ type: "text", text: "from a" }]);
    expect(notices).toEqual([]);
    expect(b.calls).toHaveLength(0);
    expect(a.calls[0]!.apiKey).toBe("key-a");
  });

  const failoverCases: [string, Script, string, number | null][] = [
    [
      "402 out of credits",
      { kind: "error", message: "402 This request requires more credits" },
      "credits_exhausted",
      402,
    ],
    ["401 key refused", { kind: "error", message: "401 Invalid API key" }, "key_refused", 401],
    ["403 key refused", { kind: "error", message: "403 Forbidden" }, "key_refused", 403],
    [
      "region refusal",
      { kind: "error", message: "403 unsupported_country_region_territory" },
      "region_refused",
      403,
    ],
    ["5xx", { kind: "error", message: "503 overloaded" }, "provider_error", 503],
    ["timeout", { kind: "error", message: "Request timed out." }, "timeout", null],
    [
      "malformed",
      { kind: "error", message: "Unexpected token < in JSON" },
      "malformed_response",
      null,
    ],
    ["empty completion", { kind: "empty" }, "malformed_response", null],
    [
      "thrown by the transport",
      { kind: "throw", error: Object.assign(new Error("boom"), { status: 502 }) },
      "provider_error",
      502,
    ],
    [
      "429 with no retry hint",
      { kind: "error", message: "429 Too many requests" },
      "rate_limited",
      429,
    ],
  ];
  for (const [name, script, cls, status] of failoverCases) {
    test(`${name}: continues on the next provider, one trace notice`, async () => {
      const a = fake("a", [script]);
      const b = fake("b", [{ kind: "ok" }]);
      const { result, notices } = await run(createProviderChain({ providers: [a.spec, b.spec] }));
      expect(result.stopReason).toBe("stop");
      expect(result.provider).toBe("b");
      expect(notices).toEqual([
        {
          action: "failover",
          from: "a",
          to: "b",
          failureClass: cls as never,
          status,
          ...(cls === "region_refused" ? { code: "unsupported_country_region_territory" } : {}),
        },
      ]);
      expect(a.calls).toHaveLength(1);
      expect(b.calls).toHaveLength(1);
    });
  }

  test("region refusal is never retried on the same provider, even with a retry hint", async () => {
    const a = fake("a", [
      { kind: "error", message: "403 unsupported_country_region_territory. Retry-After: 1" },
    ]);
    const b = fake("b", [{ kind: "ok" }]);
    const sleeps: number[] = [];
    await run(
      createProviderChain({
        providers: [a.spec, b.spec],
        sleep: async (ms) => void sleeps.push(ms),
      }),
    );
    expect(a.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test("rate limit with Retry-After: waits, retries the same provider, no failover", async () => {
    const a = fake("a", [
      { kind: "error", message: "429 Rate limit. Retry-After: 2" },
      { kind: "ok" },
    ]);
    const b = fake("b", [{ kind: "ok" }]);
    const sleeps: number[] = [];
    const { result, notices } = await run(
      createProviderChain({
        providers: [a.spec, b.spec],
        sleep: async (ms) => void sleeps.push(ms),
      }),
    );
    expect(sleeps).toEqual([2000]);
    expect(a.calls).toHaveLength(2);
    expect(b.calls).toHaveLength(0);
    expect(result.provider).toBe("a");
    expect(notices).toEqual([
      {
        action: "retry",
        from: "a",
        to: null,
        failureClass: "rate_limited",
        status: 429,
        waitMs: 2000,
      },
    ]);
  });

  test("Retry-After longer than the cap fails over at once", async () => {
    const a = fake("a", [{ kind: "error", message: "429 Rate limit. Retry-After: 120" }]);
    const b = fake("b", [{ kind: "ok" }]);
    const sleeps: number[] = [];
    const { notices } = await run(
      createProviderChain({
        providers: [a.spec, b.spec],
        maxRateLimitWaitMs: 5000,
        sleep: async (ms) => void sleeps.push(ms),
      }),
    );
    expect(sleeps).toEqual([]);
    expect(notices.map((n) => n.action)).toEqual(["failover"]);
  });

  test("a second rate limit after the retry fails over", async () => {
    const a = fake("a", [{ kind: "error", message: "429 Retry-After: 1" }]);
    const b = fake("b", [{ kind: "ok" }]);
    const { notices, result } = await run(
      createProviderChain({ providers: [a.spec, b.spec], sleep: noSleep }),
    );
    expect(a.calls).toHaveLength(2);
    expect(notices.map((n) => n.action)).toEqual(["retry", "failover"]);
    expect(result.provider).toBe("b");
  });

  test("an invalid request ends the chain without trying another provider", async () => {
    const a = fake("a", [{ kind: "error", message: "400 context_length_exceeded: too long" }]);
    const b = fake("b", [{ kind: "ok" }]);
    const { result, notices } = await run(createProviderChain({ providers: [a.spec, b.spec] }));
    expect(b.calls).toHaveLength(0);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("context_length_exceeded");
    expect(notices.map((n) => n.action)).toEqual(["exhausted"]);
  });

  test("both providers failing ends as one error carrying both failures", async () => {
    const a = fake("a", [{ kind: "error", message: "402 This request requires more credits" }]);
    const b = fake("b", [{ kind: "error", message: "403 unsupported_country_region_territory" }]);
    const { result, notices } = await run(createProviderChain({ providers: [a.spec, b.spec] }));
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("all providers failed");
    expect(result.errorMessage).toContain("a: credits_exhausted (402)");
    expect(result.errorMessage).toContain(
      "b: region_refused (403 unsupported_country_region_territory)",
    );
    expect(notices.map((n) => `${n.action}:${n.from}`)).toEqual(["failover:a", "exhausted:b"]);
  });

  test("trace notices never carry the provider's text", async () => {
    const a = fake("a", [
      { kind: "error", message: "402 secret prompt text: the customer is Acme" },
    ]);
    const b = fake("b", [{ kind: "ok" }]);
    const { notices } = await run(createProviderChain({ providers: [a.spec, b.spec] }));
    expect(JSON.stringify(notices)).not.toContain("Acme");
  });

  test("a failure after content was delivered is not replayed on another provider", async () => {
    const a = fake("a", [{ kind: "partial-then-error", message: "502 dropped" }]);
    const b = fake("b", [{ kind: "ok" }]);
    const { events, result, notices } = await run(
      createProviderChain({ providers: [a.spec, b.spec] }),
    );
    expect(b.calls).toHaveLength(0);
    expect(notices).toEqual([]);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(result.stopReason).toBe("error");
  });

  test("a failed attempt's events are not forwarded", async () => {
    const a = fake("a", [{ kind: "error", message: "402 no credits" }]);
    const b = fake("b", [{ kind: "ok" }]);
    const { events } = await run(createProviderChain({ providers: [a.spec, b.spec] }));
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    expect(events.at(-1)!.type).toBe("done");
  });

  test("sticky classes bench the provider for later calls; expiry brings it back", async () => {
    let t = 1_000;
    const a = fake("a", [{ kind: "error", message: "402 no credits" }, { kind: "ok" }]);
    const b = fake("b", [{ kind: "ok" }]);
    const chain = createProviderChain({ providers: [a.spec, b.spec], now: () => t });
    await run(chain);
    expect(a.calls).toHaveLength(1);

    const second = await run(chain);
    expect(a.calls).toHaveLength(1); // skipped, not asked again
    expect(second.result.provider).toBe("b");
    expect(second.notices).toEqual([
      { action: "failover", from: "a", to: "b", failureClass: "credits_exhausted", status: 402 },
    ]);

    t += 6 * 60_000;
    const third = await run(chain);
    expect(a.calls).toHaveLength(2);
    expect(third.result.provider).toBe("a");
  });

  test("a benched provider is still the last resort", async () => {
    let t = 0;
    const a = fake("a", [{ kind: "error", message: "402 no credits" }, { kind: "ok" }]);
    const b = fake("b", [{ kind: "error", message: "503 down" }]);
    const chain = createProviderChain({ providers: [a.spec, b.spec], now: () => t });
    const first = await run(chain);
    expect(first.result.stopReason).toBe("error");
    t += 1000;
    const second = await run(chain);
    // b is tried first (a is benched), fails, then a is tried and answers.
    expect(second.result.provider).toBe("a");
  });

  test("a provider that cannot serve the model is skipped, not failed", async () => {
    const a = fake("a", [{ kind: "ok" }], () => null);
    const b = fake("b", [{ kind: "ok" }]);
    const { result, notices } = await run(createProviderChain({ providers: [a.spec, b.spec] }));
    expect(a.calls).toHaveLength(0);
    expect(notices).toEqual([]);
    expect(result.provider).toBe("b");
  });

  test("no provider serves the model: an error naming the model", async () => {
    const a = fake("a", [{ kind: "ok" }], () => null);
    const { result } = await run(createProviderChain({ providers: [a.spec] }));
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("no provider serves model");
  });

  test("model ids are mapped per provider", async () => {
    const a = fake("a", [{ kind: "error", message: "402 x" }], (id) => id);
    const b = fake("b", [{ kind: "ok" }], (id) => id.replace("openai/", ""));
    await run(createProviderChain({ providers: [a.spec, b.spec] }));
    expect(a.calls[0]!.model).toBe("openai/gpt-5-mini");
    expect(b.calls[0]!.model).toBe("gpt-5-mini");
  });

  test("a caller abort passes through and does not fail over", async () => {
    const a = fake("a", [{ kind: "hang" }]);
    const b = fake("b", [{ kind: "ok" }]);
    const ac = new AbortController();
    const pending = run(
      createProviderChain({ providers: [a.spec, b.spec], firstEventTimeoutMs: 5_000 }),
      {
        signal: ac.signal,
      },
    );
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    const { result } = await pending;
    expect(result.stopReason).toBe("aborted");
    expect(b.calls).toHaveLength(0);
  });

  test("a provider that goes silent is failed as a timeout after firstEventTimeoutMs", async () => {
    const a = fake("a", [{ kind: "hang" }]);
    const b = fake("b", [{ kind: "ok" }]);
    const { result, notices } = await run(
      createProviderChain({ providers: [a.spec, b.spec], firstEventTimeoutMs: 20 }),
    );
    expect(result.provider).toBe("b");
    expect(notices[0]).toMatchObject({ failureClass: "timeout", from: "a", to: "b" });
  });

  test("policy overrides: a class can be made non-failover", async () => {
    const a = fake("a", [{ kind: "error", message: "503 down" }]);
    const b = fake("b", [{ kind: "ok" }]);
    const { result } = await run(
      createProviderChain({
        providers: [a.spec, b.spec],
        policy: { provider_error: { failover: false } },
      }),
    );
    expect(b.calls).toHaveLength(0);
    expect(result.stopReason).toBe("error");
  });

  test("a throwing listener does not break the call", async () => {
    const a = fake("a", [{ kind: "error", message: "402 x" }]);
    const b = fake("b", [{ kind: "ok" }]);
    const chain = createProviderChain({ providers: [a.spec, b.spec] });
    const stream = await chain.forRun(() => {
      throw new Error("listener bug");
    })(canonical, ctx);
    expect((await stream.result()).provider).toBe("b");
  });

  test("construction rejects empty and duplicate providers", () => {
    expect(() => createProviderChain({ providers: [] })).toThrow();
    const a = fake("a", [{ kind: "ok" }]);
    expect(() => createProviderChain({ providers: [a.spec, a.spec] })).toThrow(/duplicate/);
  });

  test("preResolvedModels exposes the configured models under their spec names", () => {
    const a = fake("a", [{ kind: "ok" }]);
    const chain = createProviderChain({
      providers: [a.spec],
      models: { fast: { id: "openai/gpt-5-mini", overrides: { contextWindow: 1234 } } },
    });
    const m = chain.preResolvedModels().get("fast")!;
    expect(m.model.id).toBe("openai/gpt-5-mini");
    expect(m.model.contextWindow).toBe(1234);
  });
});

// ---- shipped adapters --------------------------------------------------------

describe("adapters", () => {
  const base = {
    id: "openai/gpt-5-mini",
    name: "n",
    api: "openai-completions",
    provider: "x",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
    headers: { stale: "1" },
  } as never;

  test("openRouter: identity mapping, its own base url, key and headers", () => {
    const p = openRouter({ apiKey: "or-key", headers: { "X-Title": "t" } });
    expect(p.name).toBe("openrouter");
    expect(p.mapModel("openai/gpt-5-mini")).toBe("openai/gpt-5-mini");
    const c = p.prepare(base, "openai/gpt-5-mini");
    expect(c.model.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(c.model.provider).toBe("openrouter");
    expect(c.model.headers).toBeUndefined();
    expect(c.apiKey).toBe("or-key");
    expect(c.headers).toEqual({ "X-Title": "t" });
  });

  test("cloudflareAiGateway: endpoint, token as the key, openai-only default mapping", () => {
    const p = cloudflareAiGateway({ accountId: "acct", gatewayId: "gw", token: "cf-token" });
    expect(p.name).toBe("cloudflare-ai-gateway");
    expect(p.mapModel("openai/gpt-5-mini")).toBe("gpt-5-mini");
    expect(p.mapModel("anthropic/claude-x")).toBeNull();
    const c = p.prepare(base, "gpt-5-mini");
    expect(c.model.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/openai");
    // pi-ai sends the key as cf-aig-authorization for exactly this provider name.
    expect(c.model.provider).toBe("cloudflare-ai-gateway");
    expect(c.apiKey).toBe("cf-token");
    expect(c.headers).toBeUndefined();
  });

  test("cloudflareAiGateway: upstream key goes in Authorization; ids are url-encoded", () => {
    const p = cloudflareAiGateway({
      accountId: "a/b",
      gatewayId: "g w",
      token: "t",
      upstreamApiKey: "sk-up",
    });
    const c = p.prepare(base, "gpt-5-mini");
    expect(c.model.baseUrl).toBe("https://gateway.ai.cloudflare.com/v1/a%2Fb/g%20w/openai");
    expect(c.headers).toEqual({ Authorization: "Bearer sk-up" });
  });

  test("model id mapping is configurable: map entries win, null disables, fn is the fallback", () => {
    const p = cloudflareAiGateway({
      accountId: "a",
      gatewayId: "g",
      token: "t",
      modelMap: { "anthropic/claude-x": "claude-x", "openai/gpt-5-mini": null },
      mapModel: (id) => `custom-${id}`,
    });
    expect(p.mapModel("anthropic/claude-x")).toBe("claude-x");
    expect(p.mapModel("openai/gpt-5-mini")).toBeNull();
    expect(p.mapModel("other")).toBe("custom-other");
  });
});
