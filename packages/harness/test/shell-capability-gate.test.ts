/**
 * The harness composes `bash` only when the sandbox advertises `capabilities.shell`. The
 * conformance suite checks the declared value; this checks the gate that acts on it, through
 * a run, by looking at the tool list the model is actually sent.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent } from "@droveragent/core";
import { createNoneSandbox, type SandboxAdapter } from "@droveragent/sandbox";
import type { PreResolvedModel } from "@droveragent/model";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
} from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";

// Relative import: harness does not depend on the just-bash adapter.
import { createJustBashSandbox } from "../../sandbox-just-bash/src/index.ts";
import { runAgentEffect } from "../src/run.ts";

const model = {
  id: "custom/gate",
  name: "gate",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as unknown as PreResolvedModel["model"];

const done: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  api: "openai-completions",
  provider: "openrouter",
  model: "custom/gate",
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

/** The tool names the model is offered for a spec asking for `bash` and `read`. */
const offeredTools = async (sandbox: SandboxAdapter): Promise<string[]> => {
  let names: string[] = [];
  const streamFn: StreamFn = (_m, context) => {
    names = getCurrentTools(context.messages).map((t) => t.name);
    const s = createAssistantMessageEventStream();
    s.push({ type: "start", partial: done });
    s.push({ type: "done", reason: "stop", message: done });
    return s;
  };
  const result = await Effect.runPromise(
    runAgentEffect({
      spec: defineAgent({
        id: "gate",
        systemPrompt: "p",
        inputSchema: Type.Object({ q: Type.String() }),
        outputSchema: Type.Unknown(),
        model: "m",
        tools: ["bash", "read"],
      }),
      input: { q: "x" },
      ctx: {
        runId: "gate",
        depth: 0,
        cwd: process.cwd(),
        env: {},
        signal: new AbortController().signal,
      },
      emit: () => {},
      deps: {
        sandbox,
        preResolvedModels: new Map([["m", { model, apiKey: "k" }]]),
        streamFn,
      },
    }),
  );
  expect(result.status).toBe("success");
  return names.toSorted();
};

describe("bash is composed only with shell capability", () => {
  test("none without allowShell: no bash, other tools stay", async () => {
    expect(await offeredTools(createNoneSandbox())).toEqual(["read"]);
  });

  test("none with allowShell: bash offered", async () => {
    expect(await offeredTools(createNoneSandbox({ allowShell: true }))).toEqual(["bash", "read"]);
  });

  test("just-bash: bash offered", async () => {
    expect(await offeredTools(createJustBashSandbox())).toEqual(["bash", "read"]);
  });
});
