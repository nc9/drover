/** Chain providers as settings (#54): credentials, ids, base URL, headers and models per entry. */
import { describe, expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@mariozechner/pi-ai";

import { createProviderChain, type ChainStreamFn, type ProviderEntry } from "../src/index.ts";

type Seen = { apiKey?: string; baseUrl: string; headers?: Record<string, string>; id: string };

/** A transport that records what each call was given, then answers. */
const recording =
  (name: string, seen: Seen[], fail?: string): ChainStreamFn =>
  (model, _c, options) => {
    seen.push({
      ...(options?.apiKey ? { apiKey: options.apiKey } : {}),
      baseUrl: model.baseUrl,
      ...(model.headers ? { headers: { ...model.headers } } : {}),
      id: model.id,
    });
    const out = createAssistantMessageEventStream();
    const m: AssistantMessage = {
      role: "assistant",
      content: fail ? [] : [{ type: "text", text: `from ${name}` }],
      api: "openai-completions",
      provider: name,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: fail ? "error" : "stop",
      ...(fail ? { errorMessage: fail } : {}),
      timestamp: 0,
    };
    queueMicrotask(() => {
      if (fail) out.push({ type: "error", reason: "error", error: m });
      else {
        out.push({ type: "start", partial: m });
        out.push({ type: "done", reason: "stop", message: m });
      }
      out.end();
    });
    return out;
  };

const ctx: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never;
const canonical = (provider: string, id = "openai/gpt-5-mini") =>
  ({
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }) as Model<"openai-completions">;

const callOnce = async (
  chain: ReturnType<typeof createProviderChain>,
  provider: string,
  id?: string,
) => {
  const stream = await chain.forRun()(canonical(provider, id), ctx);
  return stream.result();
};

describe("provider entries as settings", () => {
  test("settings only: key, base URL vars, headers and a declared model; the environment is not read", async () => {
    const seen: Seen[] = [];
    const chain = createProviderChain({
      providers: [
        {
          name: "gw",
          apiKey: "sk-setting",
          baseUrl: "https://gw.test/v1/{ACCOUNT}/{GATEWAY}/openai",
          vars: { ACCOUNT: "acct-1", GATEWAY: "gw-1" },
          headers: { "cf-aig-authorization": "Bearer token-1" },
          models: { "openai/gpt-5-mini": { id: "gpt-5-mini", contextWindow: 400_000 } },
          useEnv: false,
        },
      ],
      // Conflicting environment: must not be used.
      env: { ACCOUNT: "env-acct", GATEWAY: "env-gw" },
      streams: { gw: recording("gw", seen) },
    });
    const r = await callOnce(chain, "gw");
    expect(r.stopReason).toBe("stop");
    expect(seen).toEqual([
      {
        apiKey: "sk-setting",
        baseUrl: "https://gw.test/v1/acct-1/gw-1/openai",
        headers: { "cf-aig-authorization": "Bearer token-1" },
        id: "gpt-5-mini",
      },
    ]);
    // The declared model is the one the harness sees too (context window from the declaration).
    const pre = createProviderChain({
      providers: [
        { name: "gw", apiKey: "k", models: { "openai/x": { id: "x", contextWindow: 1234 } } },
      ],
      models: { spec: "openai/x" },
    }).preResolvedModels();
    expect(pre.get("spec")!.model.contextWindow).toBe(1234);
  });

  test("useEnv: false with a missing setting is unusable, without reading the environment", async () => {
    const chain = createProviderChain({
      providers: [{ name: "openrouter", useEnv: false }],
      env: { OPENROUTER_API_KEY: "sk-from-env" },
      streams: { openrouter: recording("openrouter", []) },
    });
    const r = await callOnce(chain, "openrouter");
    expect(r.stopReason).toBe("error");
    expect(r.errorMessage).toContain('no API key for provider "openrouter"');
    expect(r.errorMessage).not.toContain("sk-from-env");
  });

  test("environment only (a plain name), and a setting overriding the environment", async () => {
    const env = { OPENROUTER_API_KEY: "sk-env" };
    const seenEnv: Seen[] = [];
    await callOnce(
      createProviderChain({
        providers: ["openrouter"],
        env,
        streams: { openrouter: recording("openrouter", seenEnv) },
      }),
      "openrouter",
    );
    expect(seenEnv[0]!.apiKey).toBe("sk-env");
    const seenSet: Seen[] = [];
    await callOnce(
      createProviderChain({
        providers: [{ name: "openrouter", apiKey: "sk-set" }],
        env,
        streams: { openrouter: recording("openrouter", seenSet) },
      }),
      "openrouter",
    );
    expect(seenSet[0]!.apiKey).toBe("sk-set");
  });

  test("two chains with different credentials for the same provider, in one process, at once", async () => {
    const seenA: Seen[] = [];
    const seenB: Seen[] = [];
    const chainFor = (key: string, seen: Seen[]) =>
      createProviderChain({
        providers: [{ name: "openrouter", apiKey: key, useEnv: false }],
        streams: { openrouter: recording("openrouter", seen) },
      });
    const [a, b] = [chainFor("sk-tenant-a", seenA), chainFor("sk-tenant-b", seenB)];
    await Promise.all([
      callOnce(a, "openrouter"),
      callOnce(b, "openrouter"),
      callOnce(a, "openrouter"),
    ]);
    expect(seenA.map((s) => s.apiKey)).toEqual(["sk-tenant-a", "sk-tenant-a"]);
    expect(seenB.map((s) => s.apiKey)).toEqual(["sk-tenant-b"]);
  });

  test("an entry's models map ids in one place; null means not served there; names must be unique", async () => {
    const seen: Seen[] = [];
    const chain = createProviderChain({
      providers: [
        { name: "a", apiKey: "k", models: { "openai/gpt-5-mini": null } },
        {
          name: "b",
          apiKey: "k",
          models: { "openai/gpt-5-mini": "b-mini" },
          baseUrl: "https://b.test",
        },
      ],
      extraModels: [{ ...canonical("b", "b-mini"), baseUrl: "https://b.test" }] as never,
      streams: { a: recording("a", seen), b: recording("b", seen) },
    });
    await callOnce(chain, "a");
    expect(seen.map((s) => s.id)).toEqual(["b-mini"]);
    expect(() => createProviderChain({ providers: ["a", { name: "a" }] })).toThrow(/listed twice/);
  });
});

/**
 * Review fixes (#73): a declared model never goes out with an empty base URL (the OpenAI SDK
 * would default to api.openai.com and send the provider's credential there), and placeholders
 * use one pattern for substitution and the leftover check. Real pi-ai transport over HTTP, with
 * a fetch spy that records every URL and answers anything but the local server itself.
 */
describe("provider entries: base URL and placeholder safety", () => {
  const withSpy = async (
    fn: (ctx: { urls: string[]; port: number; bodies: string[] }) => Promise<void>,
  ): Promise<void> => {
    const urls: string[] = [];
    const bodies: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        bodies.push(new URL(req.url).pathname);
        return new Response(JSON.stringify({ error: { message: "local", code: "x" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      if (new URL(url).hostname !== "127.0.0.1")
        return new Response('{"error":{"message":"blocked by test"}}', { status: 599 });
      return real(input, init);
    }) as typeof fetch;
    try {
      await fn({ urls, port: server.port, bodies });
    } finally {
      globalThis.fetch = real;
      await server.stop(true);
    }
  };

  test("a declared model on a provider pi-ai does not list, with no baseUrl, is refused; nothing is sent", async () => {
    await withSpy(async ({ urls }) => {
      const chain = createProviderChain({
        providers: [
          {
            name: "my-gateway",
            apiKey: "sk-secret-declared",
            models: { "openai/gpt-5-mini": { id: "gpt-5-mini" } },
            useEnv: false,
          },
        ],
      });
      const r = await callOnce(chain, "my-gateway");
      expect(r.stopReason).toBe("error");
      expect(r.errorMessage).toContain('no base URL for provider "my-gateway"');
      expect(urls).toEqual([]);
      expect(JSON.stringify(r)).not.toContain("sk-secret-declared");
    });
  });

  test("a declared model takes the overrides' base URL, then the registry's for its API; never api.openai.com", async () => {
    await withSpy(async ({ urls, port, bodies }) => {
      // overrides: the local server, placeholders filled from vars.
      const viaOverrides = createProviderChain({
        providers: [
          {
            name: "cloudflare-ai-gateway",
            apiKey: "cf-token",
            vars: { ACCT: "acct-1" },
            models: { "openai/gpt-5-mini": { id: "gpt-5-mini" } },
            useEnv: false,
          },
        ],
        overrides: {
          "cloudflare-ai-gateway": { baseUrl: `http://127.0.0.1:${port}/v1/{ACCT}/compat` },
        },
      });
      await callOnce(viaOverrides, "cloudflare-ai-gateway");
      expect(bodies).toEqual(["/v1/acct-1/compat/chat/completions"]);

      // No baseUrl anywhere: pi-ai's registry URL for openai-completions on the gateway (/compat).
      urls.length = 0;
      const viaRegistry = createProviderChain({
        providers: [
          {
            name: "cloudflare-ai-gateway",
            apiKey: "cf-token",
            vars: { CLOUDFLARE_ACCOUNT_ID: "acct-1", CLOUDFLARE_GATEWAY_ID: "gw-1" },
            models: { "openai/gpt-5-mini": { id: "gpt-5-mini" } },
            useEnv: false,
          },
        ],
        maxRateLimitWaitMs: 0,
      });
      await callOnce(viaRegistry, "cloudflare-ai-gateway");
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) {
        expect(new URL(u).hostname).toBe("gateway.ai.cloudflare.com");
        expect(new URL(u).pathname.startsWith("/v1/acct-1/gw-1/compat/")).toBe(true);
      }
      expect(urls.some((u) => u.includes("api.openai.com"))).toBe(false);
    });
  });

  test("a placeholder with a digit is filled, and left unfilled it is refused, not read by pi-ai from process.env", async () => {
    await withSpy(async ({ urls, port, bodies }) => {
      const entry = (vars?: Record<string, string>) => ({
        name: "cloudflare-ai-gateway",
        apiKey: "cf-token",
        baseUrl: `http://127.0.0.1:${port}/v1/{ACCT2}/compat`,
        ...(vars ? { vars } : {}),
        models: { "openai/gpt-5-mini": { id: "gpt-5-mini" } },
        useEnv: false,
      });
      // pi-ai fills `{NAME}` from process.env for Cloudflare providers: set one to prove it is not used.
      const before = process.env.ACCT2;
      process.env.ACCT2 = "from-process-env";
      try {
        const missing = await callOnce(
          createProviderChain({ providers: [entry()] }),
          "cloudflare-ai-gateway",
        );
        expect(missing.stopReason).toBe("error");
        expect(missing.errorMessage).toContain("no usable value for {ACCT2}");
        expect(urls).toEqual([]);

        await callOnce(
          createProviderChain({ providers: [entry({ ACCT2: "acct-2" })] }),
          "cloudflare-ai-gateway",
        );
        expect(bodies).toEqual(["/v1/acct-2/compat/chat/completions"]);
      } finally {
        if (before === undefined) delete process.env.ACCT2;
        else process.env.ACCT2 = before;
      }
    });
  });

  test("a placeholder value must be plain id characters: '/', '..', '?' are refused and never echoed", async () => {
    await withSpy(async ({ urls, port }) => {
      for (const bad of ["a/b", "..", "x?y=1", "a b", ""]) {
        const r = await callOnce(
          createProviderChain({
            providers: [
              {
                name: "gw",
                apiKey: "k",
                baseUrl: `http://127.0.0.1:${port}/v1/{ACCT}`,
                vars: { ACCT: bad },
                models: { "openai/gpt-5-mini": { id: "gpt-5-mini" } },
                useEnv: false,
              },
            ],
          }),
          "gw",
        );
        expect(r.stopReason).toBe("error");
        expect(r.errorMessage).toContain("no usable value for {ACCT}");
        if (bad !== "") expect(r.errorMessage).not.toContain(bad);
      }
      expect(urls).toEqual([]);
    });
  });
});

/** #74: Azure (registry lists no base URL) and Bedrock (one URL per region). */
describe("provider entries: Azure and Bedrock base URLs", () => {
  type Got = { baseUrl: string; options: Record<string, unknown> };
  const capture =
    (got: Got[]): ChainStreamFn =>
    (model, c, options) => {
      got.push({ baseUrl: model.baseUrl, options: { ...(options as Record<string, unknown>) } });
      return recording(model.provider, [])(model, c, options);
    };
  const run = async (entry: ProviderEntry, id: string, env: Record<string, string> = {}) => {
    const got: Got[] = [];
    const chain = createProviderChain({
      providers: [entry],
      env,
      streams: { [entry.name]: capture(got) },
    });
    const r = await callOnce(chain, entry.name, id);
    return { r, got };
  };

  test("azure: a plain entry with no base URL is refused, naming what to set", async () => {
    const { r, got } = await run(
      { name: "azure-openai-responses", apiKey: "k", useEnv: false },
      "gpt-4.1",
      { AZURE_OPENAI_RESOURCE_NAME: "ignored" },
    );
    expect(r.stopReason).toBe("error");
    expect(r.errorMessage).toContain('no base URL for provider "azure-openai-responses"');
    expect(r.errorMessage).toContain("AZURE_OPENAI_RESOURCE_NAME");
    expect(got).toEqual([]);
  });

  test("azure: baseUrl from the entry, or the entry's env (AZURE_OPENAI_BASE_URL, then the resource name); pinned as azureBaseUrl", async () => {
    const set = await run(
      {
        name: "azure-openai-responses",
        apiKey: "k",
        baseUrl: "https://acme.openai.azure.com/openai/v1",
      },
      "gpt-4.1",
      { AZURE_OPENAI_BASE_URL: "https://other.openai.azure.com/openai/v1" },
    );
    expect(set.got).toEqual([
      {
        baseUrl: "https://acme.openai.azure.com/openai/v1",
        options: expect.objectContaining({
          azureBaseUrl: "https://acme.openai.azure.com/openai/v1",
        }),
      },
    ]);
    const byUrl = await run({ name: "azure-openai-responses", apiKey: "k" }, "gpt-4.1", {
      AZURE_OPENAI_BASE_URL: "https://env.openai.azure.com/openai/v1",
      AZURE_OPENAI_RESOURCE_NAME: "not-used",
    });
    expect(byUrl.got[0]!.baseUrl).toBe("https://env.openai.azure.com/openai/v1");
    const byName = await run({ name: "azure-openai-responses", apiKey: "k" }, "gpt-4.1", {
      AZURE_OPENAI_RESOURCE_NAME: "myres",
    });
    expect(byName.got[0]!.baseUrl).toBe("https://myres.openai.azure.com/openai/v1");
    expect(byName.got[0]!.options.azureBaseUrl).toBe("https://myres.openai.azure.com/openai/v1");
    const badName = await run({ name: "azure-openai-responses", apiKey: "k" }, "gpt-4.1", {
      AZURE_OPENAI_RESOURCE_NAME: "evil.example.com/x",
    });
    expect(badName.r.errorMessage).toContain("no base URL");
    expect(badName.got).toEqual([]);
  });

  test("bedrock: the entry's region picks the endpoint and is passed as the request region", async () => {
    const { got } = await run(
      { name: "amazon-bedrock", apiKey: "k", region: "eu-west-1", useEnv: false },
      "amazon.nova-lite-v1:0",
    );
    expect(got).toEqual([
      {
        baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com",
        options: expect.objectContaining({ region: "eu-west-1" }),
      },
    ]);
  });

  test("bedrock: region from the entry's env; a baseUrl wins over it; a registry model without a region keeps its own URL", async () => {
    const env = await run({ name: "amazon-bedrock", apiKey: "k" }, "amazon.nova-lite-v1:0", {
      AWS_REGION: "ap-southeast-2",
    });
    expect(env.got[0]!.baseUrl).toBe("https://bedrock-runtime.ap-southeast-2.amazonaws.com");
    expect(env.got[0]!.options.region).toBe("ap-southeast-2");
    const custom = await run(
      {
        name: "amazon-bedrock",
        apiKey: "k",
        region: "eu-west-1",
        baseUrl: "https://vpce.example/bedrock",
      },
      "amazon.nova-lite-v1:0",
    );
    expect(custom.got[0]!.baseUrl).toBe("https://vpce.example/bedrock");
    expect(custom.got[0]!.options.region).toBe("eu-west-1");
    const plain = await run(
      { name: "amazon-bedrock", apiKey: "k", useEnv: false },
      "amazon.nova-lite-v1:0",
    );
    expect(plain.got[0]!.baseUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    expect(plain.got[0]!.options.region).toBeUndefined();
  });

  test("bedrock: a declared model needs a region or baseUrl; a bad region is refused", async () => {
    const declared = await run(
      {
        name: "amazon-bedrock",
        apiKey: "k",
        models: { "my/model": { id: "my.model-v1:0", api: "bedrock-converse-stream" } },
        useEnv: false,
      },
      "my/model",
    );
    expect(declared.r.errorMessage).toContain('a declared model needs "region" or "baseUrl"');
    expect(declared.got).toEqual([]);
    const withRegion = await run(
      {
        name: "amazon-bedrock",
        apiKey: "k",
        region: "eu-central-1",
        models: { "my/model": { id: "my.model-v1:0", api: "bedrock-converse-stream" } },
      },
      "my/model",
    );
    expect(withRegion.got[0]!.baseUrl).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
    const bad = await run(
      { name: "amazon-bedrock", apiKey: "k", region: "eu-west-1.evil.com" },
      "amazon.nova-lite-v1:0",
    );
    expect(bad.r.errorMessage).toContain("not an AWS region name");
    expect(bad.r.errorMessage).not.toContain("evil");
    expect(bad.got).toEqual([]);
  });
});
