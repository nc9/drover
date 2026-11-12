/** Chain providers as settings (#54): credentials, ids, base URL, headers and models per entry. */
import { describe, expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@mariozechner/pi-ai";

import { createProviderChain, type ChainStreamFn } from "../src/index.ts";

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
