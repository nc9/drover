/**
 * End to end: a tool call over toolCallCapPlugin's cap reaches the model as a tool error it
 * can act on, the tool does not run, and the run goes on to finish normally.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, defineTool, type HarnessEvent, type RunContext } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import type { PreResolvedModel } from "@droveragent/model";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

// Relative import: harness does not depend on plugins (no cycle, no new devDependency).
import { toolCallCapPlugin } from "../../plugins/src/tool-call-cap.ts";
import { runAgentEffect } from "../src/run.ts";

const MODEL_NAME = "cap-model";
const fakeModel = {
  id: "custom/cap",
  name: "Cap",
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
  model: "custom/cap",
  usage: zeroUsage,
  stopReason: "stop",
  timestamp: Date.now(),
  ...over,
});

describe("toolCallCapPlugin in a run", () => {
  test("three calls in one turn with a cap of 2: two run, one is refused, the run finishes", async () => {
    let executed = 0;
    const probe = defineTool({
      id: "probe",
      description: "probe",
      inputSchema: Type.Object({ n: Type.Number() }),
      execute: () => Effect.sync(() => ({ content: `ran ${++executed}` })),
    });
    const cap = toolCallCapPlugin({ maxCalls: 2, warnAt: false });
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      const s = createAssistantMessageEventStream();
      const m =
        turn === 1
          ? msg({
              stopReason: "toolUse",
              content: [1, 2, 3].map((n) => ({
                type: "toolCall" as const,
                id: `c${n}`,
                name: "probe",
                arguments: { n },
              })),
            })
          : msg({ content: [{ type: "text", text: "done" }] });
      s.push({ type: "start", partial: m });
      s.push({ type: "done", reason: m.stopReason as "stop", message: m });
      s.end();
      return s;
    };
    const spec = defineAgent({
      id: "cap-probe",
      systemPrompt: "probe",
      inputSchema: Type.Object({ q: Type.String() }),
      outputSchema: Type.Unknown(),
      model: MODEL_NAME,
      tools: [],
      plugins: [{ id: "probe-tools", tools: [probe] }, cap],
    });
    const events: HarnessEvent[] = [];
    const ctx: RunContext = {
      runId: "cap-run",
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
    expect(result.status).toBe("success");
    expect(result.finalText).toBe("done");
    expect(executed).toBe(2);
    const ends = events.filter(
      (e): e is Extract<HarnessEvent, { kind: "tool_call_end" }> => e.kind === "tool_call_end",
    );
    expect(ends).toHaveLength(3);
    const refused = ends.filter((e) => e.result.isError);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.result.content).toContain("2 of 2 tool calls used");
    expect(refused[0]!.result.content).not.toContain('"n"');
  });
});
