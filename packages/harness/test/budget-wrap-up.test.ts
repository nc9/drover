import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type HarnessEvent, type RunContext, type RunQuota } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import type { PreResolvedModel } from "@droveragent/model";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

import { runAgentEffect } from "../src/run.ts";
import type { HarnessDeps } from "../src/deps.ts";

const MODEL_NAME = "wrap-up-model";
const fakeModel = {
  id: "custom/wrap-up",
  name: "w",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as unknown as PreResolvedModel["model"];

const mkSpec = (quota: RunQuota) =>
  defineAgent({
    id: "wrap-up-probe",
    systemPrompt: "probe",
    inputSchema: Type.Object({ q: Type.String() }),
    outputSchema: Type.Unknown(),
    model: MODEL_NAME,
    tools: ["read"],
    quota,
  });

/** A model that keeps calling `read` until it sees the budget notice, then answers. */
function greedyModel(costPerCall = 0) {
  const seen: string[][] = [];
  const streamFn: StreamFn = (_m, context, options) => {
    const texts = context.messages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
    seen.push(texts);
    const warned = texts.some((t) => t.includes("Budget notice"));
    const base: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "openrouter",
      model: "custom/wrap-up",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costPerCall },
      },
      stopReason: warned ? "stop" : "toolUse",
      timestamp: Date.now(),
    };
    const final: AssistantMessage = warned
      ? { ...base, content: [{ type: "text", text: "final answer" }] }
      : {
          ...base,
          content: [
            {
              type: "toolCall",
              id: `c${seen.length}`,
              name: "read",
              arguments: { path: `${process.cwd()}/package.json` },
            },
          ],
        };
    const stream = createAssistantMessageEventStream();
    if (options?.signal?.aborted) {
      stream.push({ type: "error", reason: "aborted", error: { ...base, stopReason: "aborted" } });
      return stream;
    }
    stream.push({ type: "start", partial: base });
    stream.push({ type: "done", reason: warned ? "stop" : "toolUse", message: final });
    return stream;
  };
  return { streamFn, seen };
}

const ctx = (): RunContext => ({
  runId: "r",
  depth: 0,
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
});

async function run(quota: RunQuota, costPerCall = 0) {
  const { streamFn, seen } = greedyModel(costPerCall);
  const deps: HarnessDeps = {
    sandbox: createNoneSandbox(),
    preResolvedModels: new Map([[MODEL_NAME, { model: fakeModel, apiKey: "k" }]]),
    streamFn,
  };
  const events: HarnessEvent[] = [];
  const result = await Effect.runPromise(
    runAgentEffect({
      spec: mkSpec(quota),
      input: { q: "x" },
      ctx: ctx(),
      emit: (e) => events.push(e),
      deps,
    }),
  );
  return { result, events, seen };
}

describe("quota.wrapUp", () => {
  test("without wrapUp a greedy model is cut off at the turn budget with no answer", async () => {
    const { result } = await run({ maxTurns: 4 });
    expect(result.status).toBe("quota");
    expect(result.finalText).toBe("");
  });

  test("turns: the model is told to finish before the last allowed turn and ends with an answer", async () => {
    const { result, events, seen } = await run({ maxTurns: 4, wrapUp: {} });
    expect(result.status).toBe("success");
    expect(result.finalText).toBe("final answer");
    expect(result.turns).toBeLessThanOrEqual(4);
    const warn = events.filter((e) => e.kind === "budget_warning");
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ dimension: "turns", limit: 4 });
    // The notice is on every call after the trigger, and never on the ones before.
    const firstWarned = seen.findIndex((t) => t.some((x) => x.includes("Budget notice")));
    expect(firstWarned).toBeGreaterThan(0);
    for (let i = 0; i < seen.length; i++) {
      expect(seen[i]!.some((x) => x.includes("Budget notice"))).toBe(i >= firstWarned);
    }
  });

  test("cost: fires at the fraction of maxCostUsd", async () => {
    const { result, events } = await run({ maxCostUsd: 1, wrapUp: { at: 0.5 } }, 0.3);
    expect(result.status).toBe("success");
    expect(events.find((e) => e.kind === "budget_warning")).toMatchObject({
      dimension: "cost",
      limit: 1,
    });
  });

  test("a custom message replaces the default", async () => {
    const { seen } = await run({
      maxTurns: 4,
      wrapUp: { message: "Budget notice: wrap it up please" },
    });
    expect(seen.flat().some((t) => t === "Budget notice: wrap it up please")).toBe(true);
  });
});
