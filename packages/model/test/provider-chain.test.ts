import { describe, expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
} from "@mariozechner/pi-ai";

import {
  FAILOVER,
  classifyFailure,
  createProviderChain,
  parseRetryAfterMs,
  structuredFromBody,
  type ChainStreamFn,
  type ProviderFailoverNotice,
} from "../src/index.ts";

const REGION = "unsupported_country_region_territory";

// ---- fakes: pi-ai-shaped models for made-up providers, with a scripted transport each ----

type Script =
  | { kind: "ok"; text?: string }
  | { kind: "error"; message: string }
  | { kind: "throw"; error: Error }
  | { kind: "empty" }
  | { kind: "partial-then-error"; message: string };

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const msg = (provider: string, over: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider,
  model: "m",
  usage,
  stopReason: "stop",
  timestamp: 0,
  ...over,
});

const modelOf = (provider: string, id: string): Model<"openai-completions"> =>
  ({
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: `http://${provider}.test/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  }) as never;

function fake(name: string, scripts: Script[]) {
  const calls: { model: string; apiKey?: string; maxRetries?: number }[] = [];
  const stream: ChainStreamFn = (model, _c, options) => {
    const s = scripts[Math.min(calls.length, scripts.length - 1)]!;
    calls.push({
      model: model.id,
      ...(options?.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    });
    if (s.kind === "throw") throw s.error;
    const out = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const p = msg(name, { model: model.id });
      if (s.kind === "ok") {
        const text = s.text ?? `from ${name}`;
        const done = msg(name, {
          model: model.id,
          content: [{ type: "text", text }],
          usage: { ...usage, input: 10, output: 5, totalTokens: 15 },
        });
        out.push({ type: "start", partial: p });
        out.push({ type: "text_delta", contentIndex: 0, delta: text, partial: done });
        out.push({ type: "done", reason: "stop", message: done });
      } else if (s.kind === "error" || s.kind === "partial-then-error") {
        out.push({ type: "start", partial: p });
        if (s.kind === "partial-then-error")
          out.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "par",
            partial: msg(name, { content: [{ type: "text", text: "par" }] }),
          });
        out.push({
          type: "error",
          reason: "error",
          error: msg(name, { stopReason: "error", errorMessage: s.message }),
        });
      } else {
        out.push({ type: "start", partial: p });
        out.push({ type: "done", reason: "stop", message: p });
      }
      out.end();
    });
    return out;
  };
  return { name, stream, calls };
}
type Fake = ReturnType<typeof fake>;

const regionThrow = (extra = ""): Script => ({
  kind: "throw",
  error: Object.assign(new Error(`403 blocked${extra}`), { status: 403, error: { code: REGION } }),
});

const CANON = "openai/gpt-5-mini";
const canonical = modelOf("openrouter", CANON) as unknown as Model<never>;
const ctx: Context = { messages: [] } as never;

function chainOf(fakes: Fake[], extra: Partial<Parameters<typeof createProviderChain>[0]> = {}) {
  return createProviderChain({
    providers: fakes.map((f) => f.name),
    extraModels: fakes.flatMap((f) => [
      modelOf(f.name, CANON),
      modelOf(f.name, "gpt-5-mini"),
    ]) as never,
    apiKeys: Object.fromEntries(fakes.map((f) => [f.name, `key-${f.name}`])),
    env: {},
    streams: Object.fromEntries(fakes.map((f) => [f.name, f.stream])),
    sleep: async () => {},
    ...extra,
  });
}

/** One binding is one run. */
function bind(chain: ReturnType<typeof createProviderChain>) {
  const notices: ProviderFailoverNotice[] = [];
  return { fn: chain.forRun((n) => notices.push(n)), notices };
}
async function call(b: ReturnType<typeof bind>, signal?: AbortSignal, id = CANON) {
  const before = b.notices.length;
  const stream = await b.fn({ ...canonical, id } as never, ctx, signal ? { signal } : undefined);
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) events.push(e);
  return { events, result: await stream.result(), notices: b.notices.slice(before) };
}
const run = (chain: ReturnType<typeof createProviderChain>) => call(bind(chain));

// ---- classification ---------------------------------------------------------

describe("classifyFailure: status first, structured fields only", () => {
  const cases: [string, string, string, number | null][] = [
    ["402", "402 This request requires more credits", "credits_exhausted", 402],
    ["401", "401 Invalid API key", "key_refused", 401],
    ["403", "403 Forbidden", "key_refused", 403],
    [
      "403, body code lost to flattening",
      "403 Country, region, or territory not supported",
      "key_refused",
      403,
    ],
    ["429", "429 Rate limit reached", "rate_limited", 429],
    ["404", "404 model does not exist", "model_unavailable", 404],
    ["5xx", "502 Bad gateway", "provider_error", 502],
    ["504", "504 Gateway timeout", "timeout", 504],
    ["sdk timeout", "Request timed out.", "timeout", null],
    ["connection", "Connection error.", "timeout", null],
    ["400", "400 context_length_exceeded", "invalid_request", 400],
    ["free text, no status", "Unexpected token < in JSON", "other", null],
  ];
  for (const [name, message, cls, status] of cases) {
    test(`${name} -> ${cls}`, () => {
      const f = classifyFailure("p", { message });
      expect([f.failureClass, f.status]).toEqual([cls as never, status]);
    });
  }

  test("structured fields: region needs 403 + code; credits via 402, 403 + limit_source, 429 + insufficient_quota", () => {
    expect(classifyFailure("p", { message: "403 x", code: REGION })).toMatchObject({
      failureClass: "region_refused",
      code: REGION,
    });
    expect(
      classifyFailure("p", { message: "403 x", limitSource: "openrouter_key_limit" }).failureClass,
    ).toBe("credits_exhausted");
    expect(
      classifyFailure("p", { message: "429 x", code: "insufficient_quota" }).failureClass,
    ).toBe("credits_exhausted");
    expect(classifyFailure("p", { message: "", status: 402 }).failureClass).toBe(
      "credits_exhausted",
    );
    expect(classifyFailure("p", { message: "402" }).failureClass).toBe("credits_exhausted");
  });

  test("a structured code without its status classifies nothing", () => {
    expect(classifyFailure("p", { message: "500 x", code: REGION }).failureClass).toBe(
      "provider_error",
    );
    expect(
      classifyFailure("p", { message: "400 x", code: "insufficient_quota" }).failureClass,
    ).toBe("invalid_request");
    expect(classifyFailure("p", { message: "x", code: REGION }).failureClass).toBe("other");
  });

  for (const status of [400, 500, 503]) {
    test(`status ${status} whose text echoes credit/region tokens is not credits, region or key`, () => {
      const f = classifyFailure("p", {
        message: `${status} prompt: "insufficient_quota openrouter_key_limit ${REGION} 402 Country, region, or territory not supported"`,
      });
      expect(["credits_exhausted", "region_refused", "key_refused"]).not.toContain(f.failureClass);
      expect(f.code).toBeUndefined();
    });
  }

  test("tokens in a status-less message classify nothing", () => {
    for (const message of ["insufficient_quota", REGION, "the title was: Request timed out. 402"]) {
      expect(classifyFailure("p", { message }).failureClass).toBe("other");
    }
  });

  test("a status number inside prose is not a status; structuredFromBody reads fields only", () => {
    expect(classifyFailure("p", { message: "see page 402" }).status).toBeNull();
    expect(structuredFromBody({ error: { code: REGION, message: "insufficient_quota" } })).toEqual({
      code: REGION,
    });
    expect(
      structuredFromBody({ error: { metadata: { limit_source: "openrouter_key_limit" } } }),
    ).toEqual({ limitSource: "openrouter_key_limit" });
    expect(structuredFromBody("403 insufficient_quota")).toEqual({});
  });

  test("retry-after parsing, only trusted on a 429; table: only invalid_request ends the chain", () => {
    expect(parseRetryAfterMs("Retry-After: 7")).toBe(7000);
    expect(parseRetryAfterMs("Please try again in 1.5s")).toBe(1500);
    expect(classifyFailure("p", { message: "500 try again in 2s" }).retryAfterMs).toBeUndefined();
    for (const [cls, rule] of Object.entries(FAILOVER))
      expect(rule.failover).toBe(cls !== "invalid_request");
  });
});

// ---- chain ------------------------------------------------------------------

describe("provider chain", () => {
  test("first provider answers: no notice, second untouched, key and SDK retries set", async () => {
    const [a, b] = [fake("a", [{ kind: "ok" }]), fake("b", [{ kind: "ok" }])];
    const { result, notices } = await run(chainOf([a, b]));
    expect(result.content).toEqual([{ type: "text", text: "from a" }]);
    expect(notices).toEqual([]);
    expect(b.calls).toHaveLength(0);
    expect(a.calls[0]).toMatchObject({ apiKey: "key-a", maxRetries: 0 });
  });

  const failover: [string, Script, string, number | null][] = [
    ["402", { kind: "error", message: "402 no credits" }, "credits_exhausted", 402],
    ["401", { kind: "error", message: "401 bad key" }, "key_refused", 401],
    ["403 flattened", { kind: "error", message: "403 Forbidden" }, "key_refused", 403],
    ["region (structured)", regionThrow(), "region_refused", 403],
    ["5xx", { kind: "error", message: "503 overloaded" }, "provider_error", 503],
    ["timeout", { kind: "error", message: "Request timed out." }, "timeout", null],
    ["empty completion", { kind: "empty" }, "malformed_response", null],
    [
      "thrown with a status",
      { kind: "throw", error: Object.assign(new Error("boom"), { status: 502 }) },
      "provider_error",
      502,
    ],
    ["free text", { kind: "error", message: "something odd" }, "other", null],
    [
      "429 without a hint",
      { kind: "error", message: "429 Too many requests" },
      "rate_limited",
      429,
    ],
  ];
  for (const [name, script, cls, status] of failover) {
    test(`${name}: continues on the next provider with one notice`, async () => {
      const [a, b] = [fake("a", [script]), fake("b", [{ kind: "ok" }])];
      const { result, notices } = await run(chainOf([a, b]));
      expect(result.provider).toBe("b");
      expect(notices).toEqual([
        {
          action: "failover",
          from: "a",
          to: "b",
          failureClass: cls as never,
          status,
          ...(cls === "region_refused" ? { code: REGION } : {}),
        },
      ]);
      expect([a.calls.length, b.calls.length]).toEqual([1, 1]);
    });
  }

  test("region is not retried in place, even with a retry hint", async () => {
    const [a, b] = [fake("a", [regionThrow(". Retry-After: 1")]), fake("b", [{ kind: "ok" }])];
    const sleeps: number[] = [];
    await run(chainOf([a, b], { sleep: async (ms) => void sleeps.push(ms) }));
    expect([a.calls.length, sleeps]).toEqual([1, []]);
  });

  test("rate limit with Retry-After: wait, retry the same provider once, then fail over", async () => {
    const sleeps: number[] = [];
    const ok = fake("a", [{ kind: "error", message: "429 Retry-After: 2" }, { kind: "ok" }]);
    const first = await run(
      chainOf([ok, fake("b", [{ kind: "ok" }])], { sleep: async (ms) => void sleeps.push(ms) }),
    );
    expect(sleeps).toEqual([2000]);
    expect(first.result.provider).toBe("a");
    expect(first.notices).toEqual([
      {
        action: "retry",
        from: "a",
        to: null,
        failureClass: "rate_limited",
        status: 429,
        waitMs: 2000,
      },
    ]);

    const [a, b] = [
      fake("a", [{ kind: "error", message: "429 Retry-After: 1" }]),
      fake("b", [{ kind: "ok" }]),
    ];
    const again = await run(chainOf([a, b]));
    expect(again.notices.map((n) => n.action)).toEqual(["retry", "failover"]);

    const [c, d] = [
      fake("c", [{ kind: "error", message: "429 Retry-After: 120" }]),
      fake("d", [{ kind: "ok" }]),
    ];
    const long = await run(chainOf([c, d], { maxRateLimitWaitMs: 5000 }));
    expect(long.notices.map((n) => n.action)).toEqual(["failover"]);
  });

  test("an invalid request ends the chain without trying another provider", async () => {
    const [a, b] = [
      fake("a", [{ kind: "error", message: "400 context_length_exceeded" }]),
      fake("b", [{ kind: "ok" }]),
    ];
    const { result, notices } = await run(chainOf([a, b]));
    expect([b.calls.length, result.stopReason, result.errorMessage]).toEqual([
      0,
      "error",
      "a: invalid_request (400)",
    ]);
    expect(notices.map((n) => n.action)).toEqual(["exhausted"]);
  });

  test("both failing: one error carrying both failures as text and as diagnostics, no provider text by default", async () => {
    const mk = () => [
      fake("a", [{ kind: "error", message: "402 needs credits: SECRET-PROMPT" }]),
      fake("b", [regionThrow()]),
    ];
    const { result, notices } = await run(chainOf(mk()));
    expect(result.errorMessage).toBe(
      `all providers failed: a: credits_exhausted (402) | b: region_refused (403 ${REGION})`,
    );
    expect(JSON.stringify([result, notices])).not.toContain("SECRET");
    expect(result.diagnostics!.map((d) => d.details)).toMatchObject([
      { provider: "a", failureClass: "credits_exhausted", status: 402 },
      { provider: "b", failureClass: "region_refused", status: 403, code: REGION },
    ]);
    expect(notices.map((n) => `${n.action}:${n.from}`)).toEqual(["failover:a", "exhausted:b"]);
    const withText = await run(chainOf(mk(), { includeProviderText: true }));
    expect(withText.result.errorMessage).toContain("SECRET-PROMPT");
  });

  test("a failure after content was delivered is not replayed; a failed attempt's events are not forwarded", async () => {
    const [a, b] = [
      fake("a", [{ kind: "partial-then-error", message: "502 dropped" }]),
      fake("b", [{ kind: "ok" }]),
    ];
    const partial = await run(chainOf([a, b]));
    expect([b.calls.length, partial.notices, partial.result.stopReason]).toEqual([0, [], "error"]);
    expect(partial.events.some((e) => e.type === "text_delta")).toBe(true);

    const [c, d] = [fake("c", [{ kind: "error", message: "402 x" }]), fake("d", [{ kind: "ok" }])];
    const { events } = await run(chainOf([c, d]));
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });

  test("credits, key and region bench a provider for the rest of THIS run only", async () => {
    const mk = () => [
      fake("a", [{ kind: "error", message: "402 x" }, { kind: "ok" }]),
      fake("b", [{ kind: "ok" }]),
    ];
    const [a, b] = mk();
    const chain = chainOf([a, b]);
    const runOne = bind(chain);
    await call(runOne);
    const second = await call(runOne);
    expect(a.calls).toHaveLength(1); // not asked again in the same run
    expect(second.result.provider).toBe("b");
    const other = await call(bind(chain)); // another run asks it again
    expect([a.calls.length, other.result.provider]).toEqual([2, "a"]);
  });

  test("other classes are never benched; a benched provider is still the last resort", async () => {
    const [a, b] = [
      fake("a", [{ kind: "error", message: "503 x" }, { kind: "ok" }]),
      fake("b", [{ kind: "ok" }]),
    ];
    const runOne = bind(chainOf([a, b]));
    await call(runOne);
    expect((await call(runOne)).result.provider).toBe("a");

    const [c, d] = [
      fake("c", [{ kind: "error", message: "402 x" }, { kind: "ok" }]),
      fake("d", [{ kind: "error", message: "503 y" }]),
    ];
    const two = bind(chainOf([c, d]));
    expect((await call(two)).result.stopReason).toBe("error");
    expect((await call(two)).result.provider).toBe("c"); // d first (c benched), d fails, c answers
  });

  test("model ids come from data: the gateway default drops openai/, an ids table overrides, null skips", async () => {
    const [a, b] = [
      fake("a", [{ kind: "error", message: "402 x" }]),
      fake("cloudflare-ai-gateway", [{ kind: "ok" }]),
    ];
    await run(chainOf([a, b]));
    expect([a.calls[0]!.model, b.calls[0]!.model]).toEqual([CANON, "gpt-5-mini"]);

    const [c, d] = [fake("c", [{ kind: "ok" }]), fake("d", [{ kind: "ok" }])];
    const chain = chainOf([c, d], { ids: { [CANON]: { c: null, d: "gpt-5-mini" } } });
    const { result } = await run(chain);
    expect([c.calls.length, result.provider, d.calls[0]!.model]).toEqual([0, "d", "gpt-5-mini"]);
  });

  test("a provider that cannot serve the model, has no key or no gateway env is skipped with its reason", async () => {
    const a = fake("a", [{ kind: "ok" }]);
    const none = await run(
      createProviderChain({
        providers: ["a"],
        extraModels: [modelOf("a", CANON)] as never,
        env: {},
        streams: { a: a.stream },
      }),
    );
    expect(none.result.errorMessage).toContain('no API key for provider "a"');
    const gw = modelOf("cloudflare-ai-gateway", "gpt-5-mini");
    const noEnv = await run(
      createProviderChain({
        providers: ["cloudflare-ai-gateway"],
        extraModels: [
          { ...gw, baseUrl: "https://g/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai" },
        ] as never,
        apiKeys: { "cloudflare-ai-gateway": "t" },
        env: {},
      }),
    );
    expect(noEnv.result.errorMessage).toContain("{CLOUDFLARE_ACCOUNT_ID}");
    const nothing = await run(createProviderChain({ providers: ["z"], env: {} }));
    expect(nothing.result.errorMessage).toContain("no provider can serve");
  });

  test("overrides patch the pi-ai model per provider; the gateway placeholders are filled from env", async () => {
    let seen: Model<never> | undefined;
    const stream: ChainStreamFn = (m) => {
      seen = m as never;
      const out = createAssistantMessageEventStream();
      queueMicrotask(
        () => (
          out.push({
            type: "done",
            reason: "stop",
            message: msg("cloudflare-ai-gateway", { content: [{ type: "text", text: "x" }] }),
          }),
          out.end()
        ),
      );
      return out;
    };
    const gw = {
      ...modelOf("cloudflare-ai-gateway", "gpt-5-mini"),
      baseUrl: "https://g/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai",
    };
    const chain = createProviderChain({
      providers: ["cloudflare-ai-gateway"],
      extraModels: [gw] as never,
      apiKeys: { "cloudflare-ai-gateway": "tok" },
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_GATEWAY_ID: "gw" },
      overrides: {
        "cloudflare-ai-gateway": { compat: { maxTokensField: "max_completion_tokens" } } as never,
      },
      streams: { "cloudflare-ai-gateway": stream },
    });
    await run(chain);
    expect(seen!.baseUrl).toBe("https://g/v1/acct/gw/openai");
    expect((seen as unknown as { compat: unknown }).compat).toEqual({
      maxTokensField: "max_completion_tokens",
    });
  });

  test("a caller abort passes through and does not fail over; a throwing listener does not break the call", async () => {
    const ac = new AbortController();
    ac.abort();
    const [a, b] = [fake("a", [{ kind: "ok" }]), fake("b", [{ kind: "ok" }])];
    const { result } = await call(bind(chainOf([a, b])), ac.signal);
    expect([result.stopReason, a.calls.length + b.calls.length]).toEqual(["aborted", 0]);

    const [c, d] = [fake("c", [{ kind: "error", message: "402 x" }]), fake("d", [{ kind: "ok" }])];
    const stream = await chainOf([c, d]).forRun(() => {
      throw new Error("listener bug");
    })(canonical as never, ctx);
    expect((await stream.result()).provider).toBe("d");
  });

  test("construction rejects no providers; preResolvedModels exposes models under spec names", () => {
    expect(() => createProviderChain({ providers: [] })).toThrow();
    const a = fake("a", [{ kind: "ok" }]);
    const m = chainOf([a], { models: { fast: CANON } })
      .preResolvedModels()
      .get("fast")!;
    expect([m.model.id, m.model.contextWindow]).toEqual([CANON, 1000]);
  });
});
