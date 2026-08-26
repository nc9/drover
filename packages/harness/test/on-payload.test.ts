/**
 * `HarnessDeps.onPayload` — the host seam for provider request-body preferences
 * (OpenRouter `provider: { order, allow_fallbacks }` routing being the case that
 * motivated it).
 *
 * The regression this guards: `loopConfig` is a fixed literal, and pi spreads
 * the WHOLE config into the stream options. A field dropped from that literal is
 * silently un-passable by a host — the run still succeeds, just unrouted. So the
 * assertion is made where it matters: on the options object pi's stream function
 * actually receives.
 */
import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type RunContext } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import type { PreResolvedModel } from "@droveragent/model";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

import { runAgentEffect } from "../src/run.ts";
import type { HarnessDeps } from "../src/deps.ts";

const MODEL_NAME = "fake-routing-model";

const spec = defineAgent({
  id: "on-payload-probe",
  systemPrompt: "probe",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Unknown(),
  model: MODEL_NAME,
  tools: [],
});

const fakeModel = {
  id: "custom/routing-model",
  name: "Routing Model",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as unknown as PreResolvedModel["model"];

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Captures the options pi would hand the provider, then answers trivially. */
function capturingStreamFn(seen: { options?: Record<string, unknown> }): StreamFn {
  return ((_model, _context, options) => {
    seen.options = options as Record<string, unknown>;
    const stream = createAssistantMessageEventStream();
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "openrouter",
      model: "custom/routing-model",
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const final: AssistantMessage = { ...partial, content: [{ type: "text", text: "ok" }] };
    stream.push({ type: "start", partial });
    stream.push({ type: "done", reason: "stop", message: final });
    return stream;
  }) as StreamFn;
}

const mkCtx = (runId: string): RunContext => ({
  runId,
  depth: 0,
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
});

describe("HarnessDeps.onPayload", () => {
  test("reaches the stream call and its patch is the payload pi would send", async () => {
    const seen: { options?: Record<string, unknown> } = {};
    const deps: HarnessDeps = {
      sandbox: createNoneSandbox(),
      preResolvedModels: new Map([[MODEL_NAME, { model: fakeModel, apiKey: "sk-fake" }]]),
      streamFn: capturingStreamFn(seen),
      onPayload: (payload) => ({
        ...(payload as Record<string, unknown>),
        provider: { order: ["amazon-bedrock/us-east-1"], allow_fallbacks: true },
      }),
    };

    const result = await Effect.runPromise(
      runAgentEffect({
        spec,
        input: { q: "hi" },
        ctx: mkCtx("run-on-payload"),
        emit: () => {},
        deps,
      }),
    );
    expect(result.status).toBe("success");

    const hook = seen.options?.onPayload as
      | ((p: unknown, m: unknown) => unknown | Promise<unknown>)
      | undefined;
    expect(typeof hook).toBe("function");

    // Run it the way pi's provider does: patched body in, everything else kept.
    const patched = (await hook!({ model: "custom/routing-model", stream: true }, fakeModel)) as
      | Record<string, unknown>
      | undefined;
    expect(patched?.provider).toEqual({
      order: ["amazon-bedrock/us-east-1"],
      allow_fallbacks: true,
    });
    expect(patched?.model).toBe("custom/routing-model");
    expect(patched?.stream).toBe(true);
  });

  test("absent by default — no host hook, no key on the stream options", async () => {
    const seen: { options?: Record<string, unknown> } = {};
    const deps: HarnessDeps = {
      sandbox: createNoneSandbox(),
      preResolvedModels: new Map([[MODEL_NAME, { model: fakeModel, apiKey: "sk-fake" }]]),
      streamFn: capturingStreamFn(seen),
    };

    const result = await Effect.runPromise(
      runAgentEffect({
        spec,
        input: { q: "hi" },
        ctx: mkCtx("run-on-payload-absent"),
        emit: () => {},
        deps,
      }),
    );
    expect(result.status).toBe("success");
    expect(seen.options).toBeDefined();
    expect(seen.options?.onPayload).toBeUndefined();
  });
});
