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

const mkSpec = (quota: RunQuota, strict = false, postSuccess = false) =>
  defineAgent({
    ...(postSuccess ? { lifecycle: { postSuccess: [{ kind: "prompt", text: "POST-STEP" }] } } : {}),
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
  /** Called on every model call (e.g. to advance a fake clock); gets whether the notice is present. */
  onCall?: (noticed: boolean) => void;
  /** Usage of the answering call (default 1 in / 1 out, `costPerCall`). */
  answerUsage?: { input: number; output: number; cost?: number };
  /** The answering call fails at the provider (`stopReason: "error"`, HTTP 500). */
  answerError?: boolean;
}

function greedyModel(costPerCall = 0, opts: ModelOpts = {}) {
  const seen: string[][] = [];
  const streamFn: StreamFn = (_m, context, options) => {
    const texts = context.messages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
    seen.push(texts);
    const noticed = texts.some((t) => t.includes("Budget notice"));
    opts.onCall?.(noticed);
    // A postSuccess step ("POST-STEP") is answered directly, notice or not.
    const post = texts.some((t) => t.includes("POST-STEP"));
    const warned = post || (!opts.ignore && noticed);
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
    const answerUsage = opts.answerUsage
      ? {
          ...base.usage,
          input: opts.answerUsage.input,
          output: opts.answerUsage.output,
          totalTokens: opts.answerUsage.input + opts.answerUsage.output,
          cost: { ...base.usage.cost, total: opts.answerUsage.cost ?? costPerCall },
        }
      : base.usage;
    const final: AssistantMessage = warned
      ? {
          ...base,
          usage: post ? base.usage : answerUsage,
          content: [{ type: "text", text: post ? "post done" : (opts.answer ?? "final answer") }],
        }
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
    if (warned && !post && opts.answerError) {
      const failed: AssistantMessage = {
        ...final,
        content: [],
        stopReason: "error",
        errorMessage: "500 upstream exploded SECRET-BODY",
      };
      stream.push({ type: "error", reason: "error", error: failed });
      return stream;
    }
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
  opts: ModelOpts & {
    strict?: boolean;
    now?: () => number;
    postSuccess?: boolean;
    /** Pause the run (as `handle.pause()` does) on the first call that carries the notice. */
    pauseOnNotice?: boolean;
  } = {},
) {
  const controller = new AbortController();
  const pauseFlag = { requested: false };
  const onCall = opts.onCall;
  const { streamFn, seen } = greedyModel(costPerCall, {
    ...opts,
    onCall: (noticed) => {
      onCall?.(noticed);
      if (opts.pauseOnNotice && noticed && !pauseFlag.requested) {
        pauseFlag.requested = true;
        controller.abort();
      }
    },
  });
  const deps: HarnessDeps = {
    sandbox: createNoneSandbox(),
    preResolvedModels: new Map([[MODEL_NAME, { model: fakeModel, apiKey: "k" }]]),
    streamFn,
    ...(opts.now ? { now: opts.now } : {}),
  };
  const events: HarnessEvent[] = [];
  const result = await Effect.runPromise(
    runAgentEffect({
      spec: mkSpec(quota, opts.strict === true, opts.postSuccess === true),
      input: { q: "x" },
      ctx: { ...ctx(), signal: controller.signal },
      pauseFlag,
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
      {
        now: () => t,
        onCall: () => {
          t += 300_000;
        },
      },
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

  test("postSuccess after a wrap-up gets no notice (the base transform only)", async () => {
    const { result, seen } = await run({ maxTurns: 4, wrapUp: {} }, 0, { postSuccess: true });
    expect(result.status).toBe("success");
    expect(result.finalText).toBe("final answer");
    expect(result.wrapUp?.outcome).toBe("wrapped_up");
    const postCalls = seen.filter((t) => t.some((m) => m.includes("POST-STEP")));
    expect(postCalls.length).toBeGreaterThan(0);
    for (const call of postCalls) expect(call.some((m) => m.includes("Budget notice"))).toBe(false);
  });

  test("a pause after the warning: status paused, wrapUp reported without an outcome", async () => {
    const { result, events } = await run({ maxTurns: 6, wrapUp: {} }, 0, { pauseOnNotice: true });
    expect(events.some((e) => e.kind === "budget_warning")).toBe(true);
    expect(result.status).toBe("paused");
    expect(result.wrapUp).toBeDefined();
    expect(result.wrapUp?.dimension).toBe("turns");
    expect(result.wrapUp && "outcome" in result.wrapUp).toBe(false);
  });

  test("a validated final answer wins over the token breach of its own call (overshoot recorded)", async () => {
    // Calls report 2 tokens each; the notice comes at 6 of 10; the answer itself costs 20.
    const { result } = await run({ maxTokens: 10, wrapUp: { at: 0.5 } }, 0, {
      answerUsage: { input: 10, output: 10 },
    });
    expect(result.status).toBe("success");
    expect(result.finalText).toBe("final answer");
    expect(result.error).toBeUndefined();
    expect(result.wrapUp).toEqual({
      dimension: "tokens",
      limit: 10,
      used: 6,
      outcome: "wrapped_up",
      overshoot: { dimension: "tokens", limit: 10, observed: 26 },
    });
  });

  test("the same for cost; an answer that fails the output schema still ends quota", async () => {
    const cost = await run({ maxCostUsd: 1, wrapUp: { at: 0.5 } }, 0.3, {
      answerUsage: { input: 1, output: 1, cost: 0.6 },
    });
    expect(cost.result.status).toBe("success");
    expect(cost.result.wrapUp?.overshoot).toMatchObject({ dimension: "cost", limit: 1 });

    const invalid = await run({ maxTokens: 10, wrapUp: { at: 0.5 } }, 0, {
      strict: true,
      answer: "not json",
      answerUsage: { input: 10, output: 10 },
    });
    expect(invalid.result.status).toBe("quota");
    expect(invalid.result.wrapUp?.outcome).toBe("cut_off");
    expect(invalid.result.wrapUp?.overshoot).toBeUndefined();
  });

  test("a cost or token breach on a call that ends in a provider error ends ProviderError, not quota (#62)", async () => {
    for (const quota of [
      { maxTokens: 10, wrapUp: { at: 0.5 } },
      { maxCostUsd: 1, wrapUp: { at: 0.5 } },
    ] satisfies RunQuota[]) {
      // oxlint-disable-next-line no-await-in-loop -- two scenarios, sequential
      const { result } = await run(quota, quota.maxCostUsd ? 0.3 : 0, {
        answerError: true,
        answerUsage: { input: 10, output: 10, cost: 0.6 },
      });
      expect(result.status).toBe("error");
      expect(result.error).toMatchObject({ tag: "ProviderError", status: 500 });
      expect(result.error?.message).not.toContain("SECRET-BODY");
      expect(result.wrapUp).toBeDefined();
      expect(result.wrapUp && "outcome" in result.wrapUp).toBe(false);
      expect(result.wrapUp?.overshoot).toBeUndefined();
    }
  });

  test("turn threshold: the notice starts on turn min(ceil(at x maxTurns), maxTurns - 1), at least turn 1", async () => {
    const firstNotice = (seen: string[][]) =>
      seen.findIndex((t) => t.some((m) => m.includes("Budget notice"))) + 1; // 1-based turn
    // maxTurns 10, at 0.5: turn 5.
    expect(firstNotice((await run({ maxTurns: 10, wrapUp: { at: 0.5 } })).seen)).toBe(5);
    // maxTurns 4, default 0.8: ceil(3.2) = 4, capped at maxTurns - 1 = 3.
    expect(firstNotice((await run({ maxTurns: 4, wrapUp: {} })).seen)).toBe(3);
    // maxTurns 1: the first and only call already carries the notice.
    const one = await run({ maxTurns: 1, wrapUp: {} });
    expect(firstNotice(one.seen)).toBe(1);
    expect(one.result.status).toBe("success");
  });
});
