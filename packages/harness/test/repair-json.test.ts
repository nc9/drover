/** `repairJson` and `spec.outputRepair` (#29): conservative, syntactic, opt-in. */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type HarnessEvent, type RunContext } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import type { PreResolvedModel } from "@droveragent/model";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { repairJson } from "../src/repair-json.ts";
import { hashSpec, runAgentEffect } from "../src/run.ts";

const parse = (s: string): unknown => JSON.parse(repairJson(s) ?? s);

describe("repairJson", () => {
  test("fixes comments, trailing commas, a BOM and typographic quotes outside strings", () => {
    expect(parse('{"a": 1, "b": [1, 2,],}')).toEqual({ a: 1, b: [1, 2] });
    expect(parse('{\n  // the answer\n  "a": 1 /* sure */\n}')).toEqual({ a: 1 });
    expect(parse('﻿{"a": 1}')).toEqual({ a: 1 });
    expect(parse('{“name”: “Ada "the" Countess”}')).toEqual({
      name: 'Ada "the" Countess',
    });
    expect(parse("{‘k’: ‘v’}")).toEqual({ k: "v" });
  });

  test("never touches string contents", () => {
    const s = '{"url": "https://x.test/a//b", "note": "a, ]", "q": "“quoted” /* no */"}';
    expect(repairJson(s)).toBeNull();
    expect(JSON.parse(s).url).toBe("https://x.test/a//b");
  });

  test("never closes truncation or guesses: those stay unparseable", () => {
    for (const bad of ['{"a": 1', '{"a": "unterminated', "{a: 1}", "{'a': 1}", '{"a": 1 "b": 2}']) {
      const fixed = repairJson(bad);
      expect(() => JSON.parse(fixed ?? bad)).toThrow();
    }
    // A trailing comma is fixed (so the result is not null), but the truncation after it is not.
    const partial = repairJson('{"a": [1, 2,], "b": {"c": 1');
    expect(partial).not.toBeNull();
    expect(partial).toBe('{"a": [1, 2], "b": {"c": 1');
    expect(() => JSON.parse(partial!)).toThrow();
  });

  test("string contents are untouched when a repair happens elsewhere", () => {
    const fixed = repairJson('{"u": "a//b", "v": "x, ]", "w": "/* no */", } // c');
    expect(fixed).not.toBeNull();
    expect(JSON.parse(fixed!)).toEqual({ u: "a//b", v: "x, ]", w: "/* no */" });
  });

  test("a backslash inside typographic quotes is kept literally (escaped), not read as an escape", () => {
    const fixed = repairJson("{\u201Cp\u201D: \u201Ca\\nb\u201D}");
    expect(JSON.parse(fixed!)).toEqual({ p: "a\\nb" });
  });

  test("returns null when nothing changes", () => {
    expect(repairJson('{"a": [1, 2], "b": {"c": null}}')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------

const MODEL_NAME = "repair-model";
const fakeModel = {
  id: "custom/repair",
  name: "Repair",
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
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Answers with `replies[i]` on call i (the last one repeats). */
const answering = (replies: string[]): { streamFn: StreamFn; calls: () => number } => {
  let n = 0;
  const streamFn: StreamFn = () => {
    const text = replies[Math.min(n, replies.length - 1)]!;
    n += 1;
    const s = createAssistantMessageEventStream();
    const m: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "openrouter",
      model: "custom/repair",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      s.push({ type: "start", partial: m });
      s.push({ type: "done", reason: "stop", message: m });
      s.end();
    });
    return s;
  };
  return { streamFn, calls: () => n };
};

const runWith = async (replies: string[], outputRepair?: boolean) => {
  const { streamFn, calls } = answering(replies);
  const spec = defineAgent({
    id: "repair-probe",
    systemPrompt: "probe",
    inputSchema: Type.Object({ q: Type.String() }),
    outputSchema: Type.Object({ answer: Type.Number() }),
    model: MODEL_NAME,
    tools: [],
    ...(outputRepair !== undefined ? { outputRepair } : {}),
  });
  const events: HarnessEvent[] = [];
  const ctx: RunContext = {
    runId: `repair-${Math.random().toString(36).slice(2)}`,
    depth: 0,
    cwd: process.cwd(),
    env: {},
    signal: new AbortController().signal,
  };
  const result = await Effect.runPromise(
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
  );
  return { result, events, calls: calls() };
};

describe("spec.outputRepair", () => {
  const sloppy = '```json\n{"answer": 42, // final\n}\n```';

  test("off by default: a sloppy answer spends a retry turn", async () => {
    const { result, events, calls } = await runWith([sloppy, '{"answer": 42}']);
    expect(result.status).toBe("success");
    expect(calls).toBe(2);
    expect(events.filter((e) => e.kind === "output_retry")).toHaveLength(1);
    const v = events.find((e) => e.kind === "output_validated") as { repaired?: true };
    expect(v.repaired).toBeUndefined();
  });

  test("on: the same answer is repaired without a retry, and output_validated says so", async () => {
    const { result, events, calls } = await runWith([sloppy], true);
    expect(result.status).toBe("success");
    expect(result.output).toEqual({ answer: 42 });
    expect(calls).toBe(1);
    expect(events.filter((e) => e.kind === "output_retry")).toHaveLength(0);
    const v = events.find((e) => e.kind === "output_validated") as { repaired?: true };
    expect(v.repaired).toBe(true);
  });

  test("on: a truncated answer still spends a retry (never accepted as partial data)", async () => {
    const { result, events, calls } = await runWith(['{"answer": 4', '{"answer": 42}'], true);
    expect(calls).toBe(2);
    expect(events.filter((e) => e.kind === "output_retry")).toHaveLength(1);
    expect(result.output).toEqual({ answer: 42 });
    const v = events.find((e) => e.kind === "output_validated") as { repaired?: true };
    expect(v.repaired).toBeUndefined();
  });

  test("on: a repaired answer that fails the schema is a schema failure, retried with its issues", async () => {
    const { events } = await runWith(['{"answer": "x",}', '{"answer": 1}'], true);
    const retry = events.find((e) => e.kind === "output_retry") as { reason: string };
    expect(retry.reason).not.toContain("JSON.parse");
    expect(retry.reason).toContain("answer");
  });
});

test("repairJson: a trailing comma before a comment and the closing brace", () => {
  expect(JSON.parse(repairJson('{"a": 1, // last\n}')!)).toEqual({ a: 1 });
  expect(JSON.parse(repairJson("[1, /* x */ ]")!)).toEqual([1]);
});

test("outputRepair and toolExecution are hashed only when set", () => {
  const base = defineAgent({
    id: "hash-probe",
    systemPrompt: "x",
    inputSchema: Type.Object({}),
    outputSchema: Type.Unknown(),
    model: "m",
    tools: [],
  });
  const h = hashSpec(base);
  expect(hashSpec({ ...base, outputRepair: undefined, toolExecution: undefined })).toBe(h);
  expect(hashSpec({ ...base, outputRepair: true })).not.toBe(h);
  expect(hashSpec({ ...base, toolExecution: { parallel: 2 } })).not.toBe(h);
  expect(hashSpec({ ...base, outputRepair: true, toolExecution: { parallel: 2 } })).not.toBe(
    hashSpec({ ...base, outputRepair: true }),
  );
});
