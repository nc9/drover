/**
 * The exported failure-injection fake: each failure kind through a plain run
 * (harness ProviderError) and under a provider chain (classified failover).
 * No network: the fake never touches fetch.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type HarnessEvent, type RunContext } from "@droveragent/core";
import { runAgentEffect } from "@droveragent/harness";
import { createProviderChain } from "@droveragent/model";
import { createNoneSandbox } from "@droveragent/sandbox";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import {
  FakeProviderExhaustedError,
  fakeProvider,
  faults,
  reply,
  type FakeStep,
} from "../src/index.ts";

const MODEL = "fake-model";

const fakeModel = {
  id: "openai/gpt-4o-mini",
  name: "Fake",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as never;

const spec = defineAgent({
  id: "fake-probe",
  systemPrompt: "probe",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Unknown(),
  model: MODEL,
  tools: [],
});

const ctx = (): RunContext => ({
  runId: "fake-run",
  depth: 0,
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
});

const runPlain = async (streamFn: StreamFn) => {
  const events: HarnessEvent[] = [];
  const result = await Effect.runPromise(
    runAgentEffect({
      spec,
      input: { q: "x" },
      ctx: ctx(),
      emit: (e) => events.push(e),
      deps: {
        sandbox: createNoneSandbox(),
        preResolvedModels: new Map([[MODEL, { model: fakeModel, apiKey: "sk-fake" }]]),
        streamFn,
      },
    }),
  );
  return { result, events };
};

const runChain = async (first: FakeStep[], second: FakeStep[] = [reply.text("ok")]) => {
  const a = fakeProvider(first);
  const b = fakeProvider(second);
  const providers = createProviderChain({
    providers: ["openrouter", "openai"],
    models: { [MODEL]: "openai/gpt-4o-mini" },
    ids: { "openai/gpt-4o-mini": { openai: "gpt-4o-mini" } },
    apiKeys: { openrouter: "k1", openai: "k2" },
    streams: { openrouter: a.streamFn, openai: b.streamFn },
    sleep: async () => {},
  });
  const events: HarnessEvent[] = [];
  const result = await Effect.runPromise(
    runAgentEffect({
      spec,
      input: { q: "x" },
      ctx: ctx(),
      emit: (e) => events.push(e),
      deps: { sandbox: createNoneSandbox(), providers },
    }),
  );
  const failovers = events.filter((e) => e.kind === "provider_failover") as Array<
    HarnessEvent & { action: string; failureClass: string; status: number | null; code?: string }
  >;
  return { result, failovers, a, b };
};

describe("fakeProvider: plain run (no chain)", () => {
  const cases: Array<[string, FakeStep, string, number | undefined]> = [
    ["402 credits", faults.credits(), "provider error 402", 402],
    ["403 forbidden", faults.forbidden(), "provider error 403", 403],
    ["429 with Retry-After", faults.rateLimited(2), "provider error 429", 429],
    ["5xx", faults.serverError(503), "provider error 503", 503],
    ["timeout", faults.timeout(), "provider error", undefined],
    [
      "empty completion",
      faults.empty(),
      "provider returned an empty completion (no content)",
      undefined,
    ],
  ];
  for (const [name, step, message, status] of cases) {
    test(`${name}: the run ends ProviderError`, async () => {
      const { result } = await runPlain(fakeProvider([step]).streamFn);
      expect(result.status).toBe("error");
      expect(result.error?.tag).toBe("ProviderError");
      expect(result.error?.message).toBe(message);
      expect(result.error?.status).toBe(status);
    });
  }

  test("scripted success: tool call then text, deterministic ids", async () => {
    const fake = fakeProvider([
      reply.toolCall("nope", { a: 1 }),
      reply.text("done", { input: 5, output: 2 }),
    ]);
    const { result, events } = await runPlain(fake.streamFn);
    expect(result.status).toBe("success");
    expect(result.finalText).toBe("done");
    expect(fake.calls).toHaveLength(2);
    expect(events.find((e) => e.kind === "tool_call_start")).toMatchObject({ toolUseId: "call_0" });
  });

  test("a call past the script throws FakeProviderExhaustedError; repeatLast repeats", () => {
    const fake = fakeProvider([]);
    expect(() => fake.streamFn(fakeModel, { messages: [] })).toThrow(FakeProviderExhaustedError);
    const loop = fakeProvider([reply.text("again")], { repeatLast: true });
    loop.streamFn(fakeModel, { messages: [] });
    expect(() => loop.streamFn(fakeModel, { messages: [] })).not.toThrow();
  });
});

describe("fakeProvider: under a provider chain (streams entry)", () => {
  test("402 fails over as credits_exhausted; the run completes on the second provider", async () => {
    const { result, failovers, b } = await runChain([faults.credits()]);
    expect(result.status).toBe("success");
    expect(result.finalText).toBe("ok");
    expect(failovers).toMatchObject([
      { action: "failover", failureClass: "credits_exhausted", status: 402 },
    ]);
    expect(b.calls).toHaveLength(1);
  });

  test("bare 403 is forbidden; structured region 403 is region_refused with its code", async () => {
    expect((await runChain([faults.forbidden()])).failovers[0]).toMatchObject({
      failureClass: "forbidden",
      status: 403,
    });
    expect(
      (await runChain([faults.forbidden({ region: true, structured: true })])).failovers[0],
    ).toMatchObject({
      failureClass: "region_refused",
      status: 403,
      code: "unsupported_country_region_territory",
    });
  });

  test("429 with Retry-After is retried in place once, then answers", async () => {
    const { result, failovers, a } = await runChain([
      faults.rateLimited(1),
      reply.text("after wait"),
    ]);
    expect(result.finalText).toBe("after wait");
    expect(failovers).toMatchObject([
      { action: "retry", failureClass: "rate_limited", waitMs: 1000 },
    ]);
    expect(a.calls).toHaveLength(2);
  });

  test("5xx, timeout and empty completion fail over with their classes", async () => {
    expect((await runChain([faults.serverError(502)])).failovers[0]).toMatchObject({
      failureClass: "provider_error",
      status: 502,
    });
    expect((await runChain([faults.timeout()])).failovers[0]).toMatchObject({
      failureClass: "timeout",
    });
    expect((await runChain([faults.empty()])).failovers[0]).toMatchObject({
      failureClass: "malformed_response",
    });
  });

  test("both providers failing ends the run ProviderError listing both", async () => {
    const { result } = await runChain([faults.credits()], [faults.serverError(503)]);
    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({
      tag: "ProviderError",
      message: "provider error 503 (openrouter: credits_exhausted 402; openai: provider_error 503)",
      status: 503,
    });
  });

  test("rateLimited(0.5): the text hint and structured mode give the same 500 ms wait", async () => {
    const text = await runChain([faults.rateLimited(0.5), reply.text("ok")]);
    const structured = await runChain([
      faults.rateLimited(0.5, { structured: true }),
      reply.text("ok"),
    ]);
    expect(text.failovers[0]).toMatchObject({ action: "retry", waitMs: 500 });
    expect(structured.failovers[0]).toMatchObject({ action: "retry", waitMs: 500 });
  });
});
