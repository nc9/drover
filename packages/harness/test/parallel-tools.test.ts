/**
 * Parallel tool calls (#29): `spec.toolExecution.parallel` runs the `concurrency: "safe"`
 * calls of one model turn at the same time, at most `parallel` at once; results reach the
 * model in call order; a failure in one call does not cancel the others; an unsafe tool in
 * the turn makes the turn sequential; caps, the trace and the untrusted fence stay correct.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import {
  defineAgent,
  defineTool,
  type AnyToolDef,
  type HarnessEvent,
  type HarnessPlugin,
  type RunContext,
} from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import type { PreResolvedModel } from "@droveragent/model";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

// Relative imports: harness does not depend on plugins (no cycle, no new devDependency).
import { toolCallCapPlugin } from "../../plugins/src/tool-call-cap.ts";
import { untrustedResultsPlugin } from "../../plugins/src/untrusted-results.ts";
import { hashSpec, runAgentEffect } from "../src/run.ts";

const MODEL_NAME = "par-model";
const fakeModel = {
  id: "custom/par",
  name: "Par",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as unknown as PreResolvedModel["model"];

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const msg = (over: Partial<AssistantMessage>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider: "openrouter",
  model: "custom/par",
  usage: zeroUsage,
  stopReason: "stop",
  timestamp: Date.now(),
  ...over,
});

type Call = { name: string; n: number };

/** Turn 1 asks for `calls`; turn 2 answers. Records what the model saw on turn 2. */
const scripted = (calls: Call[]) => {
  const seen: Context[] = [];
  let turn = 0;
  const streamFn: StreamFn = (_m, context) => {
    turn += 1;
    seen.push({ messages: structuredClone(context.messages) } as Context);
    const s = createAssistantMessageEventStream();
    const m =
      turn === 1
        ? msg({
            stopReason: "toolUse",
            content: calls.map((c, i) => ({
              type: "toolCall" as const,
              id: `c${i + 1}`,
              name: c.name,
              arguments: { n: c.n },
            })),
          })
        : msg({ content: [{ type: "text", text: "done" }] });
    queueMicrotask(() => {
      s.push({ type: "start", partial: m });
      s.push({ type: "done", reason: m.stopReason as "stop", message: m });
      s.end();
    });
    return s;
  };
  return { streamFn, seen };
};

/** A tool that records how many of its calls run at once; `n` is its delay in ms. */
const gauge = () => {
  const state = { inFlight: 0, max: 0, order: [] as number[] };
  const tool = (id: string, safe: boolean, failOn?: number): AnyToolDef =>
    defineTool({
      id,
      description: id,
      inputSchema: Type.Object({ n: Type.Number() }),
      ...(safe ? { concurrency: "safe" as const } : {}),
      execute: ({ n }) =>
        Effect.promise(async () => {
          state.inFlight += 1;
          state.max = Math.max(state.max, state.inFlight);
          await new Promise((r) => setTimeout(r, n));
          state.inFlight -= 1;
          state.order.push(n);
          if (n === failOn) return { content: `failed ${n}`, isError: true };
          return { content: `ok ${n}` };
        }),
    }) as AnyToolDef;
  return { state, tool };
};

const run = async (opts: {
  calls: Call[];
  tools: AnyToolDef[];
  parallel?: number;
  plugins?: HarnessPlugin[];
  signal?: AbortSignal;
}) => {
  const { streamFn, seen } = scripted(opts.calls);
  const spec = defineAgent({
    id: "par-probe",
    systemPrompt: "probe",
    inputSchema: Type.Object({ q: Type.String() }),
    outputSchema: Type.Unknown(),
    model: MODEL_NAME,
    tools: [],
    ...(opts.parallel !== undefined ? { toolExecution: { parallel: opts.parallel } } : {}),
    plugins: [{ id: "probe-tools", tools: opts.tools }, ...(opts.plugins ?? [])],
  });
  const events: HarnessEvent[] = [];
  const ctx: RunContext = {
    runId: `par-${Math.random().toString(36).slice(2)}`,
    depth: 0,
    cwd: process.cwd(),
    env: {},
    signal: opts.signal ?? new AbortController().signal,
  };
  const either = await Effect.runPromise(
    Effect.either(
      runAgentEffect({
        spec,
        input: { q: "hi" },
        ctx,
        emit: (e) => events.push(e),
        deps: {
          sandbox: createNoneSandbox(),
          preResolvedModels: new Map([[MODEL_NAME, { model: fakeModel, apiKey: "sk-fake" }]]),
          streamFn,
        },
      }),
    ),
  );
  /** The tool results the model saw on turn 2, in message order. */
  const results = (seen[1]?.messages ?? [])
    .filter((m) => m.role === "toolResult")
    .map((m) => {
      const r = m as { toolCallId: string; isError: boolean; content: Array<{ text?: string }> };
      return { id: r.toolCallId, isError: r.isError, text: r.content.map((c) => c.text).join("") };
    });
  return { either, events, results };
};

describe("parallel tool calls", () => {
  test("default (no toolExecution): safe tools still run one at a time", async () => {
    const g = gauge();
    const { results } = await run({
      calls: [30, 20, 10].map((n) => ({ name: "look", n })),
      tools: [g.tool("look", true)],
    });
    expect(g.state.max).toBe(1);
    expect(g.state.order).toEqual([30, 20, 10]);
    expect(results.map((r) => r.id)).toEqual(["c1", "c2", "c3"]);
  });

  test("parallel: 2 caps concurrency at 2; results reach the model in call order", async () => {
    const g = gauge();
    const { results, events } = await run({
      calls: [40, 10, 30, 5].map((n) => ({ name: "look", n })),
      tools: [g.tool("look", true)],
      parallel: 2,
    });
    expect(g.state.max).toBe(2);
    // Completion order differs from call order...
    expect(g.state.order).not.toEqual([40, 10, 30, 5]);
    // ...but the model sees results in call order.
    expect(results.map((r) => r.text)).toEqual(["ok 40", "ok 10", "ok 30", "ok 5"]);
    expect(results.map((r) => r.id)).toEqual(["c1", "c2", "c3", "c4"]);
    // tool_call_end arrives in completion order; every call has one start and one end.
    const ends = events
      .filter((e) => e.kind === "tool_call_end")
      .map((e) => (e as { toolUseId: string }).toolUseId);
    expect(ends.toSorted()).toEqual(["c1", "c2", "c3", "c4"]);
    expect(events.filter((e) => e.kind === "tool_call_start")).toHaveLength(4);
  });

  test("a failure in one call does not cancel the others", async () => {
    const g = gauge();
    const { results } = await run({
      calls: [20, 5, 15].map((n) => ({ name: "look", n })),
      tools: [g.tool("look", true, 5)],
      parallel: 3,
    });
    expect(g.state.max).toBe(3);
    expect(results.map((r) => [r.text, r.isError])).toEqual([
      ["ok 20", false],
      ["failed 5", true],
      ["ok 15", false],
    ]);
  });

  test("one unsafe tool in the turn makes the whole turn sequential", async () => {
    const g = gauge();
    await run({
      calls: [
        { name: "look", n: 20 },
        { name: "touch", n: 10 },
        { name: "look", n: 5 },
      ],
      tools: [g.tool("look", true), g.tool("touch", false)],
      parallel: 4,
    });
    expect(g.state.max).toBe(1);
    expect(g.state.order).toEqual([20, 10, 5]);
  });

  test("a wrapTool that drops the flag makes the tool sequential", async () => {
    const g = gauge();
    const dropFlag: HarnessPlugin = {
      id: "drop-flag",
      wrapTool: (t) => ({
        id: t.id,
        description: t.description,
        inputSchema: t.inputSchema,
        execute: t.execute,
      }),
    };
    await run({
      calls: [10, 10, 10].map((n) => ({ name: "look", n })),
      tools: [g.tool("look", true)],
      parallel: 3,
      plugins: [dropFlag],
    });
    expect(g.state.max).toBe(1);
  });

  test("toolCallCapPlugin counts parallel calls exactly (counted before any runs)", async () => {
    const g = gauge();
    const { results } = await run({
      calls: [10, 10, 10, 10].map((n) => ({ name: "look", n })),
      tools: [g.tool("look", true)],
      parallel: 4,
      plugins: [toolCallCapPlugin({ maxCalls: 2, warnAt: false })],
    });
    expect(g.state.order).toHaveLength(2);
    expect(results.filter((r) => r.isError)).toHaveLength(2);
    expect(results.map((r) => r.id)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  test("the untrusted fence fences each parallel result with its own call's block", async () => {
    const g = gauge();
    const fence = untrustedResultsPlugin();
    const { results } = await run({
      calls: [25, 5, 15].map((n) => ({ name: "look", n })),
      tools: [g.tool("look", true)],
      parallel: 3,
      plugins: [fence],
    });
    expect(g.state.max).toBe(3);
    for (const [i, n] of [25, 5, 15].entries()) {
      // Each result is fenced, and carries its own call's text (no cross-call mix-up).
      expect(results[i]!.text).toContain(`ok ${n}`);
      expect(results[i]!.text).toContain("untrusted");
      for (const other of [25, 5, 15].filter((x) => x !== n))
        expect(results[i]!.text).not.toContain(`ok ${other}`);
    }
    expect(fence.liveRuns()).toBe(0);
  });

  test("toolExecution.parallel must be an integer >= 1", async () => {
    for (const bad of [0, 1.5, -2]) {
      const { either } = await run({
        calls: [{ name: "look", n: 1 }],
        tools: [gauge().tool("look", true)],
        parallel: bad,
      });
      expect(either._tag).toBe("Left");
      if (either._tag === "Left")
        expect((either.left as { _tag: string })._tag).toBe("SpecConfigError");
    }
  });

  test("an abort while calls wait for a slot: the waiting calls never execute", async () => {
    const g = gauge();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await run({
      calls: [80, 80, 80, 80].map((n) => ({ name: "look", n })),
      tools: [g.tool("look", true)],
      parallel: 2,
      signal: ac.signal,
    });
    // The first two held the slots when the abort came; the two waiting never started.
    expect(g.state.order).toHaveLength(2);
  });

  test("{ parallel: 1 } and {} hash like no toolExecution (same behaviour, same hash)", () => {
    const base = {
      id: "h",
      systemPrompt: "x",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      model: "m",
      tools: [] as string[],
    };
    const h = hashSpec(base);
    expect(hashSpec({ ...base, toolExecution: { parallel: 1 } })).toBe(h);
    expect(hashSpec({ ...base, toolExecution: {} })).toBe(h);
    expect(hashSpec({ ...base, toolExecution: { parallel: 2 } })).not.toBe(h);
  });
});
