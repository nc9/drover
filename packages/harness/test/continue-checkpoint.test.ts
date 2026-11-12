/**
 * Continuation state in the checkpoint (#21): `usageByProvider` stays cumulative
 * across a resume under a provider chain, and the final success checkpoint is
 * never overtaken by a slow turn checkpoint (same seq, INSERT OR REPLACE).
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type RunContext } from "@droveragent/core";
import { createProviderChain, type ChainStreamFn } from "@droveragent/model";
import { createNoneSandbox } from "@droveragent/sandbox";
import { createMemoryStorage, type StorageAdapter } from "@droveragent/storage";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { runAgentEffect } from "../src/run.ts";

const CANON = "test/cc-model";
const modelOf = (provider: string) =>
  ({
    id: CANON,
    name: CANON,
    api: "openai-completions",
    provider,
    baseUrl: `http://${provider}.test/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 1_000,
  }) as never;

const reply = (provider: string, input: number, text: string | null): AssistantMessage => ({
  role: "assistant",
  content:
    text === null
      ? [{ type: "toolCall", id: `t${Math.random()}`, name: "nope", arguments: {} }]
      : [{ type: "text", text }],
  api: "openai-completions",
  provider,
  model: CANON,
  usage: {
    input,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: text === null ? "toolUse" : "stop",
  timestamp: 0,
});

/** Answers each call with the next step: `null` = a tool call, a string = the final text. */
const scripted = (provider: string, steps: Array<[number, string | null]>) => {
  let n = 0;
  const stream: ChainStreamFn & StreamFn = () => {
    const [input, text] = steps[Math.min(n++, steps.length - 1)]!;
    const s = createAssistantMessageEventStream();
    const m = reply(provider, input, text);
    s.push({ type: "start", partial: m });
    s.push({ type: "done", reason: m.stopReason as "stop", message: m });
    s.end();
    return s;
  };
  return stream;
};

const spec = defineAgent({
  id: "cc-probe",
  systemPrompt: "probe",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Unknown(),
  model: "main",
  tools: [],
});

const ctx = (): RunContext => ({
  runId: "cc-run",
  depth: 0,
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
});

describe("continuation state in the checkpoint", () => {
  test("usageByProvider is cumulative across a continuation under a provider chain", async () => {
    const storage = createMemoryStorage();
    const chain = (input: number) =>
      createProviderChain({
        providers: ["a"],
        extraModels: [modelOf("a")],
        apiKeys: { a: "k" },
        env: {},
        streams: { a: scripted("a", [[input, "answer"]]) },
        models: { main: CANON },
      });
    const deps = (input: number) => ({
      sandbox: createNoneSandbox(),
      providers: chain(input),
      storage,
    });
    const first = await Effect.runPromise(
      runAgentEffect({ spec, input: { q: "x" }, ctx: ctx(), emit: () => {}, deps: deps(100) }),
    );
    expect(first.usageByProvider?.a?.inputTokens).toBe(100);

    const cp = await Effect.runPromise(storage.loadLatestCheckpoint("cc-run"));
    expect(cp?.usageByProvider?.a?.inputTokens).toBe(100);
    const next = await Effect.runPromise(
      runAgentEffect({
        spec,
        input: { q: "x" },
        ctx: ctx(),
        emit: () => {},
        deps: deps(40),
        resumeFrom: {
          ...cp!,
          messages: [
            ...(cp!.messages as unknown[]),
            { role: "user", content: "follow-up", timestamp: 1 },
          ],
        },
      }),
    );
    expect(next.status).toBe("success");
    expect(next.usage.inputTokens).toBe(140);
    expect(next.usageByProvider?.a?.inputTokens).toBe(140); // cumulative, like `usage`
    expect(next.usageDelta?.inputTokens).toBe(40);
  });

  test("a slow turn checkpoint never overtakes the final success checkpoint", async () => {
    const base = createMemoryStorage();
    // Turn checkpoints are slow (a remote adapter); later writes are fast.
    const delays = [40, 40];
    const writes: number[] = [];
    const slow: StorageAdapter = {
      ...base,
      saveCheckpoint: (cp) =>
        Effect.promise(() => new Promise((r) => setTimeout(r, delays.shift() ?? 0))).pipe(
          Effect.andThen(() => {
            writes.push(cp.seq);
            return base.saveCheckpoint(cp);
          }),
        ),
    };
    const result = await Effect.runPromise(
      runAgentEffect({
        spec,
        input: { q: "x" },
        ctx: ctx(),
        emit: () => {},
        deps: {
          sandbox: createNoneSandbox(),
          preResolvedModels: new Map([["main", { model: modelOf("a"), apiKey: "k" }]]),
          streamFn: scripted("a", [
            [1, null],
            [1, "final answer"],
          ]),
          storage: slow,
        },
      }),
    );
    expect(result.status).toBe("success");
    // Every write finished before the run returned, the final one last.
    expect(writes).toEqual([1, 2, 2]);
    const cp = await Effect.runPromise(base.loadLatestCheckpoint("cc-run"));
    const last = (cp!.messages as Array<{ role: string; content: unknown }>).at(-1)!;
    expect(last.role).toBe("assistant");
    expect(JSON.stringify(last.content)).toContain("final answer");
  });
});
