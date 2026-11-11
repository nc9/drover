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

const mkSpec = (quota: RunQuota, strict = false) =>
  defineAgent({
    id: "wrap-up-probe",
    systemPrompt: "probe",
    inputSchema: Type.Object({ q: Type.String() }),
    outputSchema: strict ? Type.Object({ ok: Type.Boolean() }) : Type.Unknown(),
    model: MODEL_NAME,
    tools: ["read"],
    quota,
  });

/** A model that keeps calling `read` until it sees the budget notice, then answers. */
interface ModelOpts {
  /** Keep calling tools even after the notice (a model that ignores it). */
  ignore?: boolean;
  /** The final answer text (default "final answer"). */
  answer?: string;
  /** Called on every model call (e.g. to advance a fake clock). */
  onCall?: () => void;
}

function greedyModel(costPerCall = 0, opts: ModelOpts = {}) {
  const seen: string[][] = [];
  const streamFn: StreamFn = (_m, context, options) => {
    opts.onCall?.();
    const texts = context.messages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
    seen.push(texts);
    const warned = !opts.ignore && texts.some((t) => t.includes("Budget notice"));
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
      ? { ...base, content: [{ type: "text", text: opts.answer ?? "final answer" }] }
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

async function run(
  quota: RunQuota,
  costPerCall = 0,
  opts: ModelOpts & { strict?: boolean; now?: () => number } = {},
) {
  const { streamFn, seen } = greedyModel(costPerCall, opts);
  const deps: HarnessDeps = {
    sandbox: createNoneSandbox(),
    preResolvedModels: new Map([[MODEL_NAME, { model: fakeModel, apiKey: "k" }]]),
    streamFn,
    ...(opts.now ? { now: opts.now } : {}),
  };
  const events: HarnessEvent[] = [];
  const result = await Effect.runPromise(
    runAgentEffect({
      spec: mkSpec(quota, opts.strict === true),
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

  test("tokens: maxTokens is a hard budget, and wrapUp fires at its fraction", async () => {
    // Each call reports 1 input + 1 output token.
    const cut = await run({ maxTokens: 6 });
    expect(cut.result.status).toBe("quota");
    expect(cut.result.error?.message).toBe("tokens budget exceeded (limit 6, observed 6)");
    expect(cut.result.wrapUp).toBeUndefined();

    const { result, events } = await run({ maxTokens: 10, wrapUp: { at: 0.5 } });
    expect(result.status).toBe("success");
    expect(result.finalText).toBe("final answer");
    expect(events.find((e) => e.kind === "budget_warning")).toMatchObject({
      dimension: "tokens",
      limit: 10,
      used: 6,
    });
    expect(result.wrapUp).toEqual({
      dimension: "tokens",
      limit: 10,
      used: 6,
      outcome: "wrapped_up",
    });
  });

  test("wall clock: a controllable clock crosses the threshold (the hard timer is not involved)", async () => {
    let t = 1_000_000;
    // Every model call advances the fake clock by 5 minutes; the hard limit is 1 hour.
    const { result, events, seen } = await run(
      { maxDurationMs: 3_600_000, wrapUp: { at: 0.25 } },
      0,
      { now: () => t, onCall: () => (t += 300_000) },
    );
    expect(result.status).toBe("success");
    expect(events.find((e) => e.kind === "budget_warning")).toMatchObject({
      dimension: "duration",
      limit: 3_600_000,
      used: 900_000,
    });
    expect(result.wrapUp?.outcome).toBe("wrapped_up");
    // Calls 1-3 advanced the clock to 15 minutes; call 4 is the first with the notice.
    expect(seen.findIndex((x) => x.some((m) => m.includes("Budget notice")))).toBe(3);
  });

  test("a model that ignores the notice is cut off: outcome cut_off, status quota", async () => {
    const { result, events } = await run({ maxTurns: 3, wrapUp: {} }, 0, { ignore: true });
    expect(events.some((e) => e.kind === "budget_warning")).toBe(true);
    expect(result.status).toBe("quota");
    expect(result.wrapUp).toMatchObject({ dimension: "turns", limit: 3, outcome: "cut_off" });
  });

  test("output schema: the wrap-up answer is still decoded and validated", async () => {
    const { result } = await run({ maxTurns: 4, wrapUp: {} }, 0, {
      strict: true,
      answer: '{"ok":true}',
    });
    expect(result.status).toBe("success");
    expect(result.output).toEqual({ ok: true });
    expect(result.wrapUp?.outcome).toBe("wrapped_up");
  });

  test("the notice is the operator's text verbatim, whatever the tools returned", async () => {
    const message = "Budget notice: operator text only";
    const { seen } = await run({ maxTurns: 4, wrapUp: { message } });
    const notices = seen.flat().filter((t) => t.startsWith("Budget notice"));
    expect(notices.length).toBeGreaterThan(0);
    expect(new Set(notices)).toEqual(new Set([message]));
  });
});
