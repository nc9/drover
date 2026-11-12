/**
 * Compaction under a provider chain (#44): a summaryModel outside the chain goes
 * straight to pi-ai and compacts; a summary call that the chain fails with a
 * chain-shaped provider error keeps the history (CompactionError).
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type HarnessEvent, type RunContext } from "@droveragent/core";
import { createProviderChain, type ChainStreamFn, type PreResolvedModel } from "@droveragent/model";
import { createNoneSandbox } from "@droveragent/sandbox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";

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

const msg = (provider: string, over: Partial<AssistantMessage>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider,
  model: CANON,
  usage: usage(5),
  stopReason: "stop",
  timestamp: 0,
  ...over,
});

/** Main-loop calls (system prompt "probe"): two tool calls, then text. Summary calls: `onSummary`. */
/** One conversation across providers: the script position is shared, whichever provider serves. */
const shared = { mainCalls: 0, mainContexts: [] as number[] };
const provider = (name: string, onSummary: "fail402" | "fail503" | "never") => {
  let summaryCalls = 0;
  const stream: ChainStreamFn = (_model, context) => {
    const out = createAssistantMessageEventStream();
    // The harness composes the agent's prompt; the summariser sends its own.
    const isSummary = !String(context.systemPrompt).includes("probe");
    let m: AssistantMessage;
    if (isSummary) {
      summaryCalls += 1;
      if (onSummary === "never") throw new Error("summary call must not reach the chain");
      const text = onSummary === "fail402" ? "402 the transcript said SECRET" : "503 SECRET down";
      m = msg(name, { stopReason: "error", errorMessage: text, usage: usage(0) });
      out.push({ type: "error", reason: "error", error: m });
    } else {
      shared.mainContexts.push(context.messages.length);
      const n = shared.mainCalls++;
      m =
        n < 2
          ? msg(name, {
              stopReason: "toolUse",
              content: [
                {
                  type: "toolCall",
                  id: `t${n}`,
                  name: "nope",
                  arguments: { pad: "x".repeat(400) },
                },
              ],
            })
          : msg(name, { content: [{ type: "text", text: "final" }] });
      out.push({ type: "start", partial: m });
      out.push({ type: "done", reason: m.stopReason as "stop", message: m });
    }
    out.end();
    return out;
  };
  return { stream, summaryCalls: () => summaryCalls };
};

const run = async (
  streams: Record<string, ChainStreamFn>,
  summaryModel: string | undefined,
  extraModels: Map<string, PreResolvedModel> = new Map(),
) => {
  shared.mainCalls = 0;
  shared.mainContexts = [];
  const providers = createProviderChain({
    providers: ["a", "b"],
    extraModels: [modelOf("a", CANON), modelOf("b", CANON)],
    apiKeys: { a: "ka", b: "kb" },
    env: {},
    streams,
    models: { main: CANON },
    sleep: async () => {},
  });
  const spec = defineAgent({
    id: "chain-compaction-probe",
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
      ...(summaryModel ? { summaryModel } : {}),
    },
  });
  const events: HarnessEvent[] = [];
  const ctx: RunContext = {
    runId: "cc-run",
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
      deps: { sandbox: createNoneSandbox(), providers, preResolvedModels: extraModels },
    }),
  );
  return { result, events };
};

describe("compaction under a provider chain", () => {
  test("a summaryModel outside the chain goes straight to pi-ai and compacts", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1;
        return new Response(
          `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "s", choices: [{ index: 0, delta: { role: "assistant", content: "SUMMARY OF EARLIER WORK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const a = provider("a", "never");
      const b = provider("b", "never");
      const outside = new Map<string, PreResolvedModel>([
        [
          "small",
          {
            model: modelOf("elsewhere", "small-model", `http://127.0.0.1:${server.port}/v1`),
            apiKey: "outside-key",
          },
        ],
      ]);
      const { result, events } = await run({ a: a.stream, b: b.stream }, "small", outside);
      expect(result.status).toBe("success");
      expect(hits).toBeGreaterThanOrEqual(1);
      expect(a.summaryCalls() + b.summaryCalls()).toBe(0);
      expect(events.some((e) => e.kind === "compaction" && e.summarized)).toBe(true);
      expect(events.some((e) => e.kind === "error" && e.tag === "CompactionError")).toBe(false);
      expect(events.some((e) => e.kind === "provider_failover")).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("a chain-shaped provider error on the summary call keeps history: CompactionError, no provider text", async () => {
    const a = provider("a", "fail402");
    const b = provider("b", "fail503");
    const { result, events } = await run({ a: a.stream, b: b.stream }, undefined);
    expect(result.status).toBe("success");
    expect(a.summaryCalls()).toBeGreaterThanOrEqual(1);
    const errs = events.filter((e) => e.kind === "error" && e.tag === "CompactionError");
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect((errs[0] as { message: string }).message).toContain(
      "summary call failed: provider error",
    );
    expect(events.some((e) => e.kind === "compaction" && e.summarized)).toBe(false);
    // History kept: each main call saw everything before it (a is benched after its 402
    // on the summary call, so the last main call is served by b).
    expect(shared.mainContexts).toEqual([1, 3, 5]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });
});
