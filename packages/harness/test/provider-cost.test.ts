import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type RunContext } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import type { PreResolvedModel } from "@droveragent/model";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

import { runAgentEffect } from "../src/run.ts";
import { pendingProviderCostCalls, withProviderCost } from "../src/provider-cost.ts";

const MODEL_NAME = "cost-probe-model";

const spec = defineAgent({
  id: "cost-probe",
  systemPrompt: "probe",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Unknown(),
  model: MODEL_NAME,
  tools: [],
});

const sse = (cost: number | undefined): string =>
  [
    `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "custom/cost", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}`,
    ``,
    `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "custom/cost", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    ``,
    `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "custom/cost", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, ...(cost !== undefined ? { cost } : {}) } })}`,
    ``,
    `data: [DONE]`,
    ``,
    ``,
  ].join("\n");

const models = (port: number): Map<string, PreResolvedModel> =>
  new Map([
    [
      MODEL_NAME,
      {
        model: {
          id: "custom/cost",
          name: "Cost",
          api: "openai-completions",
          provider: "openrouter",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          reasoning: false,
          input: ["text"],
          // list price: $1 / 1M in + $1 / 1M out => 0.0011 for the usage above
          cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_192,
        } as unknown as PreResolvedModel["model"],
        apiKey: "sk-fake",
      },
    ],
  ]);

const ctx = (runId: string): RunContext => ({
  runId,
  depth: 0,
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
});

const run = (port: number, runId: string, streamFn: StreamFn | undefined) =>
  Effect.runPromise(
    runAgentEffect({
      spec,
      input: { q: "hi" },
      ctx: ctx(runId),
      emit: () => {},
      deps: {
        sandbox: createNoneSandbox(),
        preResolvedModels: models(port),
        ...(streamFn ? { streamFn } : {}),
      },
    }),
  );

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => {
  await server?.stop(true);
  server = undefined;
});

describe("withProviderCost", () => {
  test("costUsd is the provider-billed cost, request asks for usage.include, tag header never leaves", async () => {
    const seen: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({ body: (await req.json()) as Record<string, unknown>, headers: req.headers });
        return new Response(sse(0.0123), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const r = await run(server.port!, "billed", withProviderCost());
    expect(r.status).toBe("success");
    expect(r.finalText).toBe("ok");
    expect(r.usage.costUsd).toBeCloseTo(0.0123, 10);
    expect(r.usage.inputTokens).toBe(1000);
    expect(seen[0]!.body.usage).toEqual({ include: true });
    expect([...seen[0]!.headers.keys()].some((k) => k.startsWith("x-drover"))).toBe(false);
  });

  test("baseline without the wrapper: list-price cost (what pi computes today)", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(sse(0.0123), { headers: { "content-type": "text/event-stream" } }),
    });
    const r = await run(server.port!, "list", undefined);
    expect(r.usage.costUsd).toBeCloseTo(0.0011, 10);
  });

  test("no cost from the provider: list-price cost is kept", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(sse(undefined), { headers: { "content-type": "text/event-stream" } }),
    });
    const r = await run(server.port!, "nocost", withProviderCost());
    expect(r.usage.costUsd).toBeCloseTo(0.0011, 10);
  });

  test("concurrent runs each get their own billed cost", async () => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const q = JSON.stringify(await req.json());
        const cost = q.includes("hi-a") ? 0.5 : 0.25;
        return new Response(sse(cost), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const fn = withProviderCost();
    const go = (runId: string, q: string) =>
      Effect.runPromise(
        runAgentEffect({
          spec,
          input: { q },
          ctx: ctx(runId),
          emit: () => {},
          deps: {
            sandbox: createNoneSandbox(),
            preResolvedModels: models(server!.port!),
            streamFn: fn,
          },
        }),
      );
    const [a, b] = await Promise.all([go("a", "hi-a"), go("b", "hi-b")]);
    expect(a.usage.costUsd).toBeCloseTo(0.5, 10);
    expect(b.usage.costUsd).toBeCloseTo(0.25, 10);
  });

  test("composes with a caller onPayload and leaves untagged fetches alone", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let seenTag = false;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push((await req.json()) as Record<string, unknown>);
        seenTag ||= req.headers.has("x-drover-cost-tag");
        return new Response(sse(0.01), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const wrapped = withProviderCost();
    // Untagged request through the (now installed) global tap: untouched.
    const plain = await fetch(`http://127.0.0.1:${server.port}/v1/x`, {
      method: "POST",
      body: JSON.stringify({ plain: true }),
    });
    expect(await plain.text()).toContain("[DONE]");
    expect(bodies[0]).toEqual({ plain: true });

    // Caller onPayload (as the harness would pass via options) is applied first.
    const calls: unknown[] = [];
    const base: StreamFn = async (_m, _c, options) => {
      calls.push(await options?.onPayload?.({ provider: { order: ["x"] } }, {} as never));
      const s = createAssistantMessageEventStream();
      s.end();
      return s;
    };
    const wrappedBase = withProviderCost(base);
    await wrappedBase(
      { provider: "openrouter" } as never,
      { messages: [] },
      { onPayload: (p) => ({ ...(p as object), extra: 1 }) },
    );
    expect(calls[0]).toEqual({ provider: { order: ["x"] }, extra: 1, usage: { include: true } });
    expect(seenTag).toBe(false);
    void wrapped;
  });

  test("non-OpenRouter model (gateway style): payload and headers untouched, no tap", async () => {
    const seen: Array<{ payload: unknown; headers: Record<string, string> | undefined }> = [];
    const base: StreamFn = async (_m, _c, options) => {
      const payload = await options?.onPayload?.({ model: "x" }, {} as never);
      seen.push({ payload, headers: options?.headers });
      const s = createAssistantMessageEventStream();
      s.end();
      return s;
    };
    const before = globalThis.fetch;
    const gateway = {
      provider: "openai",
      baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/openai",
    } as never;
    await withProviderCost(base)(gateway, { messages: [] }, { headers: { "x-keep": "1" } });
    expect(seen[0]!.payload).toBeUndefined(); // base saw no onPayload to call: untouched
    expect(seen[0]!.headers).toEqual({ "x-keep": "1" });
    expect(globalThis.fetch).toBe(before);
    expect(pendingProviderCostCalls()).toBe(0);
  });

  test("a request that never reaches fetch leaves no pending entry", async () => {
    const throwing: StreamFn = () => {
      throw new Error("aborted before fetch");
    };
    const or = { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" } as never;
    await expect(withProviderCost(throwing)(or, { messages: [] })).rejects.toThrow("before fetch");
    expect(pendingProviderCostCalls()).toBe(0);

    // Stream that ends with an error event and never issues a request.
    const errored: StreamFn = () => {
      const s = createAssistantMessageEventStream();
      s.push({
        type: "error",
        reason: "aborted",
        error: {
          role: "assistant",
          content: [],
          api: "openai-completions",
          provider: "openrouter",
          model: "x",
          usage: usage0,
          stopReason: "aborted",
          timestamp: 0,
        },
      });
      s.end();
      return s;
    };
    const s = await withProviderCost(errored)(or, { messages: [] });
    await s.result();
    await new Promise((r) => setTimeout(r, 10));
    expect(pendingProviderCostCalls()).toBe(0);
  });
});

const usage0 = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
