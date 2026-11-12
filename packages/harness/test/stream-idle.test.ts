/**
 * #81 round 2: every model call of a run is watched for idleness, including the compaction
 * summariser without a chain (pi-ai's own transport) and a summaryModel outside a chain. A
 * summary call that never answers ends as a CompactionError and the run goes on.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type HarnessEvent, type RunContext } from "@droveragent/core";
import { createProviderChain, type ChainStreamFn, type PreResolvedModel } from "@droveragent/model";
import { createNoneSandbox } from "@droveragent/sandbox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

import type { HarnessDeps } from "../src/deps.ts";
import { runAgentEffect } from "../src/run.ts";

const CANON = "test/main-model";
const modelOf = (provider: string, id: string, baseUrl = `http://${provider}.test/v1`) =>
  ({
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 1_000,
  }) as never;
const usage = (output: number) => ({
  input: 10,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 10 + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** Main loop: two padded tool calls (so compaction triggers), then a text answer. */
const mainScript = () => {
  let n = 0;
  const fn = ((model: { provider: string }) => {
    const out = createAssistantMessageEventStream();
    const i = n++;
    const m: AssistantMessage = {
      role: "assistant",
      content:
        i < 2
          ? [{ type: "toolCall", id: `t${i}`, name: "nope", arguments: { pad: "x".repeat(400) } }]
          : [{ type: "text", text: "final" }],
      api: "openai-completions",
      provider: model.provider,
      model: CANON,
      usage: usage(5),
      stopReason: i < 2 ? "toolUse" : "stop",
      timestamp: 0,
    };
    queueMicrotask(() => {
      out.push({ type: "start", partial: m });
      out.push({ type: "done", reason: m.stopReason as "stop", message: m });
      out.end();
    });
    return out;
  }) as unknown as ChainStreamFn;
  return fn;
};

/** A server that accepts the summary request and never answers. */
const hangingServer = () => {
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      hits += 1;
      return new Promise<Response>(() => {});
    },
  });
  return { server, hits: () => hits };
};

const runWith = async (deps: Partial<HarnessDeps>, summaryModel: string) => {
  const spec = defineAgent({
    id: "idle-compaction-probe",
    systemPrompt: "probe",
    inputSchema: Type.Object({ q: Type.String() }),
    outputSchema: Type.Unknown(),
    model: "main",
    tools: [],
    compaction: {
      strategy: ["summarize"],
      preserve: { firstUserTurn: true, recentTurns: 1 },
      trigger: { kind: "input_tokens", value: 50 },
      summaryPrompt: "summarise",
      summaryModel,
    },
  });
  const events: HarnessEvent[] = [];
  const ctx: RunContext = {
    runId: `idle-${Math.random().toString(36).slice(2)}`,
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
      deps: { sandbox: createNoneSandbox(), ...deps },
    }),
  );
  return { result, events };
};

describe("idle watchdog on the compaction summariser", () => {
  test("no chain: a summary call that never answers times out as a CompactionError; the run goes on", async () => {
    const { server, hits } = hangingServer();
    try {
      const started = Date.now();
      const { result, events } = await runWith(
        {
          streamFn: mainScript() as unknown as StreamFn,
          streamIdleTimeoutMs: 80,
          preResolvedModels: new Map<string, PreResolvedModel>([
            ["main", { model: modelOf("openrouter", CANON), apiKey: "k" }],
            [
              "small",
              {
                model: modelOf("elsewhere", "small", `http://127.0.0.1:${server.port}/v1`),
                apiKey: "k",
              },
            ],
          ]),
        },
        "small",
      );
      expect(hits()).toBeGreaterThanOrEqual(1);
      expect(result.status).toBe("success");
      expect(events.some((e) => e.kind === "error" && e.tag === "CompactionError")).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await server.stop(true);
    }
  });

  test("under a chain: a summaryModel outside the chain is watched too", async () => {
    const { server, hits } = hangingServer();
    try {
      const providers = createProviderChain({
        providers: ["a"],
        extraModels: [modelOf("a", CANON)],
        apiKeys: { a: "ka" },
        env: {},
        streams: { a: mainScript() },
        models: { main: CANON },
        streamIdleTimeoutMs: 80,
      });
      const { result, events } = await runWith(
        {
          providers,
          preResolvedModels: new Map<string, PreResolvedModel>([
            [
              "small",
              {
                model: modelOf("elsewhere", "small", `http://127.0.0.1:${server.port}/v1`),
                apiKey: "k",
              },
            ],
          ]),
        },
        "small",
      );
      expect(hits()).toBeGreaterThanOrEqual(1);
      expect(result.status).toBe("success");
      expect(events.some((e) => e.kind === "error" && e.tag === "CompactionError")).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});
