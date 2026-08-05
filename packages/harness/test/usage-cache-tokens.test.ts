import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type HarnessEvent, type RunContext } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import type { PreResolvedModel } from "@droveragent/model";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

import { runAgentEffect } from "../src/run.ts";
import type { HarnessDeps } from "../src/deps.ts";

const MODEL_NAME = "fake-cache-model";

const spec = defineAgent({
  id: "usage-probe",
  systemPrompt: "probe",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Unknown(),
  model: MODEL_NAME,
  tools: [],
});

const fakeModel = {
  id: "custom/cache-model",
  name: "Cache Model",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as unknown as PreResolvedModel["model"];

// pi-ai semantics: `input` EXCLUDES cached prompt tokens. A cached system
// prompt puts most of the request in cacheRead — dropping it under-counts
// the run several-fold (the platform #17 bug).
const usage = {
  input: 3,
  output: 2,
  cacheRead: 90,
  cacheWrite: 10,
  totalTokens: 105,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const scriptedStreamFn: StreamFn = () => {
  const stream = createAssistantMessageEventStream();
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "openrouter",
    model: "custom/cache-model",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const final: AssistantMessage = {
    ...partial,
    content: [{ type: "text", text: "Hello" }],
  };
  stream.push({ type: "start", partial });
  stream.push({ type: "text_delta", contentIndex: 0, delta: "Hello", partial });
  stream.push({ type: "done", reason: "stop", message: final });
  return stream;
};

const mkCtx = (runId: string): RunContext => ({
  runId,
  depth: 0,
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
});

const deps: HarnessDeps = {
  sandbox: createNoneSandbox(),
  preResolvedModels: new Map([[MODEL_NAME, { model: fakeModel, apiKey: "sk-fake" }]]),
  streamFn: scriptedStreamFn,
};

describe("runAgentEffect — cache token accounting", () => {
  test("run usage carries cacheRead/cacheWrite, not just input/output", async () => {
    const events: HarnessEvent[] = [];
    const result = await Effect.runPromise(
      runAgentEffect({
        spec,
        input: { q: "hi" },
        ctx: mkCtx("run-cache-usage"),
        emit: (e) => events.push(e),
        deps,
      }),
    );
    expect(result.status).toBe("success");
    expect(result.usage.inputTokens).toBe(3);
    expect(result.usage.outputTokens).toBe(2);
    expect(result.usage.cacheReadTokens).toBe(90);
    expect(result.usage.cacheWriteTokens).toBe(10);

    // The translated per-message usage event carries them too.
    const usageEvent = events.find((e) => e.kind === "usage") as
      | { usage?: { cacheReadTokens?: number; cacheWriteTokens?: number } }
      | undefined;
    expect(usageEvent?.usage?.cacheReadTokens).toBe(90);
    expect(usageEvent?.usage?.cacheWriteTokens).toBe(10);
  });
});
