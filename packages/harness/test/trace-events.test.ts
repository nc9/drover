/** A real run's events all read as typed trace-format events, and summarise to the expected numbers. */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import {
  defineAgent,
  readEvent,
  summarizeTrace,
  type HarnessEvent,
  type RunContext,
} from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import type { PreResolvedModel } from "@droveragent/model";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { runAgentEffect } from "../src/run.ts";

const model = {
  id: "custom/t",
  name: "t",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as unknown as PreResolvedModel["model"];

const reply = (
  content: AssistantMessage["content"],
  stop: "stop" | "toolUse",
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "openrouter",
  model: "custom/t",
  usage: {
    input: 3,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 5,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
  },
  stopReason: stop,
  timestamp: Date.now(),
});

describe("trace format against a real run", () => {
  test("every emitted event is a typed v1 event", async () => {
    let n = 0;
    const streamFn: StreamFn = () => {
      const m =
        n++ === 0
          ? reply(
              [
                {
                  type: "toolCall",
                  id: "c1",
                  name: "read",
                  arguments: { path: `${process.cwd()}/package.json` },
                },
              ],
              "toolUse",
            )
          : reply([{ type: "text", text: "done" }], "stop");
      const s = createAssistantMessageEventStream();
      s.push({ type: "start", partial: m });
      s.push({ type: "done", reason: m.stopReason as "stop" | "toolUse", message: m });
      return s;
    };
    const events: HarnessEvent[] = [];
    const ctx: RunContext = {
      runId: "r",
      depth: 0,
      cwd: process.cwd(),
      env: {},
      signal: new AbortController().signal,
    };
    await Effect.runPromise(
      runAgentEffect({
        spec: defineAgent({
          id: "t",
          systemPrompt: "p",
          inputSchema: Type.Object({ q: Type.String() }),
          outputSchema: Type.Unknown(),
          model: "m",
          tools: ["read"],
        }),
        input: { q: "x" },
        ctx,
        emit: (e) => events.push(e),
        deps: {
          sandbox: createNoneSandbox(),
          preResolvedModels: new Map([["m", { model, apiKey: "k" }]]),
          streamFn,
        },
      }),
    );
    const typed = events.map((e) => readEvent(JSON.parse(JSON.stringify(e))));
    expect(typed.filter((e) => "unknown" in e)).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining([
        "run_start",
        "turn_start",
        "tool_call_start",
        "tool_call_end",
        "usage",
        "run_end",
      ]),
    );
    const s = summarizeTrace(typed);
    expect(s).toMatchObject({
      status: "success",
      turns: 2,
      toolCalls: { count: 1, errors: 0 },
      usage: { inputTokens: 6, outputTokens: 4 },
    });
  });
});
