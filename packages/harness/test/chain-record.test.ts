/**
 * The per-run provider chain record (#52): one entry per configured provider in chain order,
 * on the result and as the `chain_record` event, including providers that only failed.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type HarnessEvent, type RunContext } from "@droveragent/core";
import { createProviderChain, type ChainStreamFn } from "@droveragent/model";
import { createNoneSandbox } from "@droveragent/sandbox";
import { createMemoryStorage, type StorageAdapter } from "@droveragent/storage";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai/compat";

import { runAgentEffect } from "../src/run.ts";

const CANON = "test/record-model";
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

type Step = "tool" | "text" | `fail:${string}`;

/** Scripted provider: each call takes the next step (the last repeats). */
const provider = (name: string, steps: Step[]) => {
  let n = 0;
  const stream: ChainStreamFn = () => {
    const step = steps[Math.min(n++, steps.length - 1)]!;
    const out = createAssistantMessageEventStream();
    const base: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: name,
      model: CANON,
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    if (step.startsWith("fail:")) {
      out.push({
        type: "error",
        reason: "error",
        error: {
          ...base,
          stopReason: "error",
          errorMessage: `${step.slice(5)} SECRET provider text`,
        },
      });
    } else {
      const m: AssistantMessage =
        step === "tool"
          ? {
              ...base,
              stopReason: "toolUse",
              content: [{ type: "toolCall", id: `t${n}`, name: "nope", arguments: {} }],
            }
          : { ...base, content: [{ type: "text", text: "done" }] };
      out.push({ type: "start", partial: m });
      out.push({ type: "done", reason: m.stopReason as "stop", message: m });
    }
    out.end();
    return out;
  };
  return stream;
};

const spec = defineAgent({
  id: "record-probe",
  systemPrompt: "probe",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Unknown(),
  model: "main",
  tools: [],
});

const run = async (
  streams: Record<string, ChainStreamFn>,
  storage?: StorageAdapter,
  resumeFrom?: Parameters<typeof runAgentEffect>[0]["resumeFrom"],
) => {
  const names = Object.keys(streams);
  const providers = createProviderChain({
    providers: names,
    extraModels: names.map(modelOf),
    apiKeys: Object.fromEntries(names.map((p) => [p, `key-${p}`])),
    env: {},
    streams,
    models: { main: CANON },
    sleep: async () => {},
  });
  const events: HarnessEvent[] = [];
  const ctx: RunContext = {
    runId: "rec-run",
    depth: 0,
    cwd: process.cwd(),
    env: {},
    signal: new AbortController().signal,
  };
  const result = await Effect.runPromise(
    runAgentEffect({
      spec,
      input: { q: "x" },
      ctx,
      emit: (e) => events.push(e),
      deps: { sandbox: createNoneSandbox(), providers, ...(storage ? { storage } : {}) },
      ...(resumeFrom ? { resumeFrom } : {}),
    }),
  );
  return { result, events };
};

const row = (
  provider: string,
  over: Partial<{
    answered: number;
    failed: number;
    failures: object;
    benchedAtTurn: number | null;
  }>,
) => expect.objectContaining({ provider, answered: 0, failed: 0, benchedAtTurn: null, ...over });

describe("chain record", () => {
  test("failover on the first call: the failed provider has a row, skipped from turn 1", async () => {
    const { result, events } = await run({
      a: provider("a", ["fail:401"]),
      b: provider("b", ["tool", "text"]),
    });
    expect(result.status).toBe("success");
    expect(result.chainRecord).toEqual([
      row("a", { failed: 1, failures: { key_refused: 1 }, benchedAtTurn: 1 }),
      row("b", { answered: 2 }),
    ]);
    expect(result.chainRecord![0]!.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(result.chainRecord![1]!.usage).toEqual({
      inputTokens: 20,
      outputTokens: 4,
      costUsd: 0.02,
    });
    // Emitted once, right before run_end, equal to the result's.
    const kinds = events.map((e) => e.kind);
    expect(kinds.filter((k) => k === "chain_record")).toHaveLength(1);
    expect(kinds.at(-2)).toBe("chain_record");
    expect((events.at(-2) as { providers: unknown }).providers).toEqual(result.chainRecord);
  });

  test("failover mid-run: the first provider answered, then failed; nothing is skipped for a 5xx", async () => {
    const { result } = await run({
      a: provider("a", ["tool", "fail:503"]),
      b: provider("b", ["text"]),
    });
    expect(result.chainRecord).toEqual([
      row("a", { answered: 1, failed: 1, failures: { provider_error: 1 } }),
      row("b", { answered: 1 }),
    ]);
  });

  test("all providers failing: every provider has its row; no provider text anywhere", async () => {
    const { result, events } = await run({
      a: provider("a", ["fail:402"]),
      b: provider("b", ["fail:503"]),
    });
    expect(result.status).toBe("error");
    expect(result.chainRecord).toEqual([
      row("a", { failed: 1, failures: { credits_exhausted: 1 }, benchedAtTurn: 1 }),
      row("b", { failed: 1, failures: { provider_error: 1 } }),
    ]);
    expect(
      JSON.stringify([result.chainRecord, events.filter((e) => e.kind === "chain_record")]),
    ).not.toContain("SECRET");
  });

  test("a single-provider run has a one-entry record", async () => {
    const { result } = await run({ only: provider("only", ["text"]) });
    expect(result.chainRecord).toEqual([row("only", { answered: 1 })]);
  });

  test("a continuation appends to the record of the run's previous invocation", async () => {
    const storage = createMemoryStorage();
    const first = await run(
      { a: provider("a", ["fail:401"]), b: provider("b", ["text"]) },
      storage,
    );
    expect(first.result.chainRecord).toEqual([
      row("a", { failed: 1, failures: { key_refused: 1 }, benchedAtTurn: 1 }),
      row("b", { answered: 1 }),
    ]);
    const cp = await Effect.runPromise(storage.loadLatestCheckpoint("rec-run"));
    const next = await run(
      { a: provider("a", ["text"]), b: provider("b", ["text"]) }, // a works again now
      storage,
      {
        ...cp!,
        messages: [...(cp!.messages as unknown[]), { role: "user", content: "more", timestamp: 1 }],
      },
    );
    expect(next.result.status).toBe("success");
    expect(next.result.chainRecord).toEqual([
      row("a", { answered: 1, failed: 1, failures: { key_refused: 1 }, benchedAtTurn: 1 }),
      row("b", { answered: 1 }),
    ]);
    expect(next.result.chainRecord![0]!.usage.inputTokens).toBe(10);
    expect(next.result.chainRecord![1]!.usage.inputTokens).toBe(10);
  });

  test("resuming a pre-upgrade checkpoint carries the old Azure name over as `azure`", async () => {
    const storage = createMemoryStorage();
    const OLD = "azure-openai-responses";
    const usage = (n: number) => ({ inputTokens: n, outputTokens: 1, costUsd: 0.5 });
    // Hand-built pre-1.0.3 state: the record and the usage split name the provider `OLD`.
    await Effect.runPromise(
      storage.appendEvent({
        runId: "rec-run",
        seq: 1,
        ts: 1,
        kind: "chain_record",
        payload: {
          kind: "chain_record",
          runId: "rec-run",
          ts: 1,
          providers: [
            {
              provider: OLD,
              answered: 3,
              failed: 2,
              failures: { rate_limited: 2 },
              benchedAtTurn: null,
              usage: usage(300),
            },
            {
              provider: "b",
              answered: 0,
              failed: 0,
              failures: {},
              benchedAtTurn: null,
              usage: { inputTokens: 0, outputTokens: 0 },
            },
          ],
        } as HarnessEvent,
      }),
    );
    const cp = {
      runId: "rec-run",
      seq: 3,
      messages: [
        { role: "user", content: "first", timestamp: 1 },
        { role: "user", content: "more", timestamp: 2 },
      ],
      usage: usage(300),
      toolCalls: [],
      retriesUsed: 0,
      usageByProvider: { [OLD]: usage(300) },
      ts: 0,
    };
    const { result } = await run(
      { azure: provider("azure", ["text"]), b: provider("b", ["text"]) },
      storage,
      cp as never,
    );
    expect(result.status).toBe("success");
    // Counts carry over under `azure`, with this invocation's answer added; no old-name row.
    expect(result.chainRecord!.map((e) => e.provider)).toEqual(["azure", "b"]);
    expect(result.chainRecord![0]).toMatchObject({
      answered: 4,
      failed: 2,
      failures: { rate_limited: 2 },
    });
    expect(result.chainRecord![0]!.usage.inputTokens).toBe(310);
    // usageByProvider is rekeyed too, never duplicated.
    expect(Object.keys(result.usageByProvider ?? {})).toEqual(["azure"]);
    expect(result.usageByProvider!["azure"]!.inputTokens).toBe(310);
  });
});
