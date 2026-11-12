/**
 * Reasoning tokens (#43): pi-ai's `Usage.reasoning` (a subset of output) reaches the run
 * usage, `usageDelta`, `usageByProvider` and the per-call `usage` event. Absent, never 0,
 * when the provider reports no split (pi-ai fills 0 for several providers that return none).
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type HarnessEvent, type RunContext } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import { createMemoryStorage } from "@droveragent/storage";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { runAgentEffect } from "../src/run.ts";

const model = {
  id: "m",
  name: "m",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "http://test.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
} as never;

const spec = defineAgent({
  id: "reasoning-probe",
  systemPrompt: "probe",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Unknown(),
  model: "m",
  tools: [],
});

/** One scripted reply per call: `reasoning` is what pi-ai reports (a number, or omitted). */
const script = (steps: Array<{ text: string | null; reasoning?: number }>) => {
  let n = 0;
  const streamFn: StreamFn = () => {
    const step = steps[Math.min(n++, steps.length - 1)]!;
    const m: AssistantMessage = {
      role: "assistant",
      content:
        step.text === null
          ? [{ type: "toolCall", id: `t${n}`, name: "nope", arguments: {} }]
          : [{ type: "text", text: step.text }],
      api: "openai-completions",
      provider: "openrouter",
      model: "m",
      usage: {
        input: 10,
        output: 20,
        ...(step.reasoning === undefined ? {} : { reasoning: step.reasoning }),
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: step.text === null ? "toolUse" : "stop",
      timestamp: 0,
    };
    const s = createAssistantMessageEventStream();
    s.push({ type: "start", partial: m });
    s.push({ type: "done", reason: m.stopReason as "stop", message: m });
    s.end();
    return s;
  };
  return streamFn;
};

const ctx = (): RunContext => ({
  runId: "rt-run",
  depth: 0,
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
});

const base = (streamFn: StreamFn, storage = createMemoryStorage()) => ({
  spec,
  input: { q: "x" },
  ctx: ctx(),
  deps: {
    sandbox: createNoneSandbox(),
    preResolvedModels: new Map([["m", { model, apiKey: "k" }]]),
    streamFn,
    storage,
  },
});

describe("reasoning tokens", () => {
  test("summed per run, per provider and per call; outputTokens keeps its meaning", async () => {
    const events: HarnessEvent[] = [];
    const result = await Effect.runPromise(
      runAgentEffect({
        ...base(
          script([
            { text: null, reasoning: 5 },
            { text: "done", reasoning: 7 },
          ]),
        ),
        emit: (e) => events.push(e),
      }),
    );
    expect(result.status).toBe("success");
    expect(result.usage.reasoningTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(40); // includes reasoning: not added to
    expect(result.usageDelta?.reasoningTokens).toBe(12);
    expect(result.usageByProvider?.openrouter?.reasoningTokens).toBe(12);
    const perCall = events
      .filter((e) => e.kind === "usage")
      .map((e) => (e as { usage: { reasoningTokens?: number } }).usage.reasoningTokens);
    expect(perCall).toEqual([5, 7]);
  });

  test("absent, never 0, when the provider reports none (undefined or pi-ai's filled 0)", async () => {
    for (const reasoning of [undefined, 0]) {
      const events: HarnessEvent[] = [];
      const result = await Effect.runPromise(
        runAgentEffect({
          ...base(script([{ text: "done", ...(reasoning === undefined ? {} : { reasoning }) }])),
          emit: (e) => events.push(e),
        }),
      );
      expect(Object.hasOwn(result.usage, "reasoningTokens")).toBe(false);
      expect(Object.hasOwn(result.usageDelta ?? {}, "reasoningTokens")).toBe(false);
      expect(Object.hasOwn(result.usageByProvider?.openrouter ?? {}, "reasoningTokens")).toBe(
        false,
      );
      const usageEvent = events.find((e) => e.kind === "usage") as { usage: object };
      expect(Object.hasOwn(usageEvent.usage, "reasoningTokens")).toBe(false);
    }
  });

  test("cumulative across a resume, with usageDelta covering only the new invocation", async () => {
    const storage = createMemoryStorage();
    const first = await Effect.runPromise(
      runAgentEffect({
        ...base(script([{ text: "one", reasoning: 5 }]), storage),
        emit: () => {},
      }),
    );
    expect(first.usage.reasoningTokens).toBe(5);
    const cp = await Effect.runPromise(storage.loadLatestCheckpoint("rt-run"));
    expect(cp?.usage.reasoningTokens).toBe(5);
    const next = await Effect.runPromise(
      runAgentEffect({
        ...base(script([{ text: "two", reasoning: 4 }]), storage),
        emit: () => {},
        resumeFrom: {
          ...cp!,
          messages: [
            ...(cp!.messages as unknown[]),
            { role: "user", content: "more", timestamp: 1 },
          ],
        },
      }),
    );
    expect(next.usage.reasoningTokens).toBe(9);
    expect(next.usageDelta?.reasoningTokens).toBe(4);
    expect(next.usageByProvider?.openrouter?.reasoningTokens).toBe(9);
  });
});
