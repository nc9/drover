/**
 * `budget` (per invocation): a resume or continuation gets its own turns,
 * tokens, cost and time, counted from where it starts, on top of the spec's
 * cumulative `quota`.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type InvocationBudget, type RunContext } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import type { PreResolvedModel } from "@droveragent/model";
import type { CheckpointRow } from "@droveragent/storage";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

import { runAgentEffect } from "../src/run.ts";

const MODEL_NAME = "budget-model";

const fakeModel = {
  id: "custom/budget",
  name: "Budget",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as unknown as PreResolvedModel["model"];

const usage = (input: number, output: number, cost = 0) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

const msg = (over: Partial<AssistantMessage>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider: "openrouter",
  model: "custom/budget",
  usage: usage(0, 0),
  stopReason: "stop",
  timestamp: Date.now(),
  ...over,
});

/** Every call: a tool call (so the loop keeps going) with the given usage, after `delayMs`. */
const toolLoop =
  (input: number, output: number, cost = 0, delayMs = 0): StreamFn =>
  (_model, _context, options) => {
    const s = createAssistantMessageEventStream();
    if (options?.signal?.aborted) {
      // A fake that honours the abort, like pi-ai's providers.
      const aborted = msg({ stopReason: "aborted", errorMessage: "aborted" });
      s.push({ type: "error", reason: "aborted", error: aborted });
      s.end();
      return s;
    }
    const m = msg({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: `c${Math.random()}`, name: "nope", arguments: {} }],
      usage: usage(input, output, cost),
    });
    setTimeout(() => {
      s.push({ type: "start", partial: m });
      s.push({ type: "done", reason: "toolUse", message: m });
      s.end();
    }, delayMs);
    return s;
  };

const textOnce =
  (input: number, output: number): StreamFn =>
  () => {
    const s = createAssistantMessageEventStream();
    const m = msg({ content: [{ type: "text", text: "done" }], usage: usage(input, output) });
    s.push({ type: "start", partial: m });
    s.push({ type: "done", reason: "stop", message: m });
    s.end();
    return s;
  };

/** A stored run that already spent 10 turns, 1 000 tokens and $5. */
const checkpoint: CheckpointRow = {
  runId: "b-run",
  seq: 10,
  messages: [
    { role: "user", content: "earlier", timestamp: 1 },
    msg({ content: [{ type: "text", text: "earlier answer" }] }),
    { role: "user", content: "follow-up", timestamp: 2 },
  ],
  usage: { inputTokens: 800, outputTokens: 200, costUsd: 5 },
  toolCalls: [],
  retriesUsed: 0,
  ts: 3,
};

const resume = (streamFn: StreamFn, budget?: InvocationBudget, quota?: object) => {
  const spec = defineAgent({
    id: "budget-probe",
    systemPrompt: "probe",
    inputSchema: Type.Object({ q: Type.String() }),
    outputSchema: Type.Unknown(),
    model: MODEL_NAME,
    tools: [],
    ...(quota ? { quota } : {}),
  });
  const ctx: RunContext = {
    runId: "b-run",
    depth: 0,
    cwd: process.cwd(),
    env: {},
    signal: new AbortController().signal,
  };
  return Effect.runPromise(
    runAgentEffect({
      spec,
      input: { q: "x" },
      ctx,
      emit: () => {},
      deps: {
        sandbox: createNoneSandbox(),
        preResolvedModels: new Map([[MODEL_NAME, { model: fakeModel, apiKey: "sk-fake" }]]),
        streamFn,
      },
      resumeFrom: checkpoint,
      ...(budget ? { budget } : {}),
    }),
  );
};

describe("per-invocation budget", () => {
  test("turns are counted from the resume point, not from the run's start", async () => {
    const r = await resume(toolLoop(1, 1), { maxTurns: 2 });
    expect(r.status).toBe("quota");
    expect(r.error?.message).toBe("invocation turns budget exceeded (limit 2, observed 2)");
    expect(r.turns).toBeGreaterThanOrEqual(12); // cumulative counter: 10 before + this invocation
  });

  test("tokens: input + output of this invocation only", async () => {
    const r = await resume(toolLoop(30, 20), { maxTokens: 100 });
    expect(r.status).toBe("quota");
    expect(r.error?.message).toBe("invocation tokens budget exceeded (limit 100, observed 100)");
    expect(r.usageDelta).toEqual({ inputTokens: 60, outputTokens: 40 });
    expect(r.usage.inputTokens).toBe(860);
  });

  test("cost: USD of this invocation only", async () => {
    const r = await resume(toolLoop(1, 1, 0.4), { maxCostUsd: 1 });
    expect(r.status).toBe("quota");
    expect(r.error?.message).toStartWith("invocation cost budget exceeded (limit 1,");
    expect(r.usageDelta?.costUsd).toBeCloseTo(1.2);
  });

  test("duration: wall clock of this invocation", async () => {
    const r = await resume(toolLoop(1, 1, 0, 30), { maxDurationMs: 50 });
    expect(r.status).toBe("quota");
    expect(r.error?.message).toStartWith("invocation duration budget exceeded (limit 50,");
  });

  test("a budget above this invocation's spend lets it finish, whatever the run spent before", async () => {
    const r = await resume(textOnce(40, 9), {
      maxTurns: 2,
      maxTokens: 100,
      maxCostUsd: 1,
      maxDurationMs: 5_000,
    });
    expect(r.status).toBe("success");
    expect(r.usageDelta).toEqual({ inputTokens: 40, outputTokens: 9 });
  });

  test("the spec's quota stays cumulative across the run", async () => {
    const r = await resume(textOnce(40, 9), { maxTokens: 1_000 }, { maxCostUsd: 5 });
    expect(r.status).toBe("quota");
    expect(r.error?.message).toBe("cost budget exceeded (limit 5, observed 5)");
  });
});
