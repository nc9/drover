/**
 * `maxTurns` is a budget, not a tripwire: a validated final answer on the last
 * allowed turn ends `success`. A tool call on that turn, or an answer that fails
 * the output schema, still ends `quota`.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type, type TSchema } from "@sinclair/typebox";
import { defineAgent, type HarnessEvent, type RunContext } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import type { PreResolvedModel } from "@droveragent/model";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { runAgentEffect } from "../src/run.ts";

const MODEL = "turns-model";
const fakeModel = {
  id: "custom/turns",
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

type Step = { tool: true } | { text: string };

/** Answers call N with `steps[N]`; counts calls; honours the abort signal. */
function scripted(steps: Step[]) {
  const state = { calls: 0, contexts: [] as string[][] };
  const streamFn: StreamFn = (_m, context, options) => {
    const s = createAssistantMessageEventStream();
    const base: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "openrouter",
      model: "custom/turns",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    if (options?.signal?.aborted) {
      s.push({ type: "error", reason: "aborted", error: { ...base, stopReason: "aborted" } });
      return s;
    }
    state.contexts.push(
      context.messages.map((m) => (typeof m.content === "string" ? m.content : "")),
    );
    const step = steps[Math.min(state.calls, steps.length - 1)]!;
    state.calls += 1;
    const m: AssistantMessage =
      "tool" in step
        ? {
            ...base,
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: `c${state.calls}`,
                name: "read",
                arguments: { path: `${process.cwd()}/package.json` },
              },
            ],
          }
        : { ...base, content: [{ type: "text", text: step.text }] };
    s.push({ type: "start", partial: m });
    s.push({ type: "done", reason: m.stopReason as "stop" | "toolUse", message: m });
    return s;
  };
  return { streamFn, state };
}

const run = async (
  maxTurns: number,
  steps: Step[],
  opts: { outputSchema?: TSchema; postSuccess?: boolean } = {},
) => {
  const { streamFn, state } = scripted(steps);
  const events: HarnessEvent[] = [];
  const ctx: RunContext = {
    runId: "turns-run",
    depth: 0,
    cwd: process.cwd(),
    env: {},
    signal: new AbortController().signal,
  };
  const result = await Effect.runPromise(
    runAgentEffect({
      spec: defineAgent({
        id: "turns-probe",
        systemPrompt: "probe",
        inputSchema: Type.Object({ q: Type.String() }),
        outputSchema: opts.outputSchema ?? Type.Unknown(),
        model: MODEL,
        tools: ["read"],
        quota: { maxTurns },
        ...(opts.postSuccess
          ? { lifecycle: { postSuccess: [{ kind: "prompt" as const, text: "POST-STEP" }] } }
          : {}),
      }),
      input: { q: "x" },
      ctx,
      emit: (e) => events.push(e),
      deps: {
        sandbox: createNoneSandbox(),
        preResolvedModels: new Map([[MODEL, { model: fakeModel, apiKey: "k" }]]),
        streamFn,
      },
    }),
  );
  return { result, events, state };
};

describe("maxTurns is a budget, not a tripwire", () => {
  test("maxTurns: 1 with an answer on turn 1 ends success", async () => {
    const { result, events } = await run(1, [{ text: "done" }]);
    expect(result.status).toBe("success");
    expect(result.finalText).toBe("done");
    expect(result.error).toBeUndefined();
    expect(events.some((e) => e.kind === "output_validated")).toBe(true);
  });

  test("maxTurns: N with a validated answer on turn N ends success", async () => {
    const { result, state } = await run(3, [{ tool: true }, { tool: true }, { text: "done" }]);
    expect(state.calls).toBe(3);
    expect(result.status).toBe("success");
    expect(result.finalText).toBe("done");
    expect(result.toolCalls).toEqual(["read", "read"]);
  });

  test("a tool call on turn N still ends quota", async () => {
    const { result } = await run(3, [{ tool: true }]);
    expect(result.status).toBe("quota");
    expect(result.error).toMatchObject({
      tag: "QuotaExceededError",
      message: "turns budget exceeded (limit 3, observed 3)",
    });
  });

  test("with an output schema: a valid answer on the last turn is success, an invalid one is quota", async () => {
    const schema = Type.Object({ ok: Type.Boolean() });
    const valid = await run(2, [{ tool: true }, { text: '{"ok":true}' }], { outputSchema: schema });
    expect(valid.result.status).toBe("success");
    expect(valid.result.output).toEqual({ ok: true });
    const invalid = await run(2, [{ tool: true }, { text: "not json" }], { outputSchema: schema });
    expect(invalid.result.status).toBe("quota");
    expect(invalid.result.output).toBeUndefined();
  });

  test("postSuccess is skipped when the answer used the last allowed turn", async () => {
    const { result, state } = await run(1, [{ text: "done" }], { postSuccess: true });
    expect(result.status).toBe("success");
    expect(state.calls).toBe(1);
    expect(state.contexts.flat().some((t) => t.includes("POST-STEP"))).toBe(false);
  });

  test("a provider error with partial text on the cap turn stays an error, not a forgiven answer", async () => {
    const partialError: StreamFn = () => {
      const s = createAssistantMessageEventStream();
      const m: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "partial ans" }],
        api: "openai-completions",
        provider: "openrouter",
        model: "custom/turns",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "502 upstream dropped",
        timestamp: Date.now(),
      };
      s.push({ type: "start", partial: m });
      s.push({ type: "error", reason: "error", error: m });
      return s;
    };
    const events: HarnessEvent[] = [];
    const result = await Effect.runPromise(
      runAgentEffect({
        spec: defineAgent({
          id: "turns-probe",
          systemPrompt: "probe",
          inputSchema: Type.Object({ q: Type.String() }),
          outputSchema: Type.Unknown(),
          model: MODEL,
          tools: [],
          quota: { maxTurns: 1 },
        }),
        input: { q: "x" },
        ctx: {
          runId: "turns-err",
          depth: 0,
          cwd: process.cwd(),
          env: {},
          signal: new AbortController().signal,
        },
        emit: (e) => events.push(e),
        deps: {
          sandbox: createNoneSandbox(),
          preResolvedModels: new Map([[MODEL, { model: fakeModel, apiKey: "k" }]]),
          streamFn: partialError,
        },
      }),
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({
      tag: "ProviderError",
      message: "provider error 502",
      status: 502,
    });
    expect(events.some((e) => e.kind === "output_validated")).toBe(false);
  });
});
