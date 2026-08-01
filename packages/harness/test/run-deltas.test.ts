import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type HarnessEvent, type RunContext } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import { createMemoryStorage } from "@droveragent/storage/memory";
import type { PreResolvedModel } from "@droveragent/model";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

import { runAgentEffect } from "../src/run.ts";
import type { HarnessDeps } from "../src/deps.ts";

const MODEL_NAME = "fake-delta-model";

const spec = defineAgent({
  id: "delta-probe",
  systemPrompt: "probe",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Unknown(),
  model: MODEL_NAME,
  tools: [],
});

const fakeModel = {
  id: "custom/delta-model",
  name: "Delta Model",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as unknown as PreResolvedModel["model"];

const usage = {
  input: 3,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Scripted transport: one assistant message streamed as thinking + text
 * token deltas (plus a toolcall_delta that must stay dropped), then done.
 * Events are queued synchronously; pi's loop drains them via async iteration.
 */
const scriptedStreamFn: StreamFn = () => {
  const stream = createAssistantMessageEventStream();
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "openrouter",
    model: "custom/delta-model",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const final: AssistantMessage = {
    ...partial,
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "Hello" },
    ],
  };
  stream.push({ type: "start", partial });
  stream.push({ type: "thinking_delta", contentIndex: 0, delta: "hmm", partial });
  stream.push({ type: "text_delta", contentIndex: 1, delta: "Hel", partial });
  stream.push({ type: "text_delta", contentIndex: 1, delta: "lo", partial });
  stream.push({ type: "toolcall_delta", contentIndex: 2, delta: '{"x":', partial });
  stream.push({ type: "done", reason: "stop", message: final });
  return stream;
};

const mkCtx = (runId: string): RunContext => ({
  runId,
  depth: 0,
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
});

const mkDeps = (storage?: HarnessDeps["storage"]): HarnessDeps => ({
  sandbox: createNoneSandbox(),
  preResolvedModels: new Map([[MODEL_NAME, { model: fakeModel, apiKey: "sk-fake" }]]),
  streamFn: scriptedStreamFn,
  ...(storage ? { storage } : {}),
});

const runAndCollect = async (
  runId: string,
  opts: { emitDeltas?: boolean; storage?: HarnessDeps["storage"] } = {},
): Promise<{ events: HarnessEvent[]; status: string }> => {
  const events: HarnessEvent[] = [];
  const result = await Effect.runPromise(
    runAgentEffect({
      spec,
      input: { q: "hi" },
      ctx: mkCtx(runId),
      emit: (e) => events.push(e),
      deps: mkDeps(opts.storage),
      ...(opts.emitDeltas ? { emitDeltas: true } : {}),
    }),
  );
  return { events, status: result.status };
};

describe("runAgentEffect — token-delta streaming", () => {
  test("default: no delta events; whole-message assistant_text/thinking only", async () => {
    const { events, status } = await runAndCollect("run-no-deltas");
    expect(status).toBe("success");
    const kinds = events.map((e) => e.kind);
    expect(kinds).not.toContain("assistant_delta");
    expect(kinds).not.toContain("thinking_delta");
    const text = events.find((e) => e.kind === "assistant_text");
    expect(text).toMatchObject({ text: "Hello" });
  });

  test("emitDeltas: deltas stream in order and the whole-message events still arrive", async () => {
    const { events, status } = await runAndCollect("run-deltas", { emitDeltas: true });
    expect(status).toBe("success");
    const assistantDeltas = events.filter((e) => e.kind === "assistant_delta");
    expect(assistantDeltas.map((e) => (e as { text: string }).text)).toEqual(["Hel", "lo"]);
    const thinkingDeltas = events.filter((e) => e.kind === "thinking_delta");
    expect(thinkingDeltas.map((e) => (e as { text: string }).text)).toEqual(["hmm"]);
    // Deltas arrive BEFORE the whole-message assistant_text.
    const firstDeltaIdx = events.findIndex((e) => e.kind === "assistant_delta");
    const textIdx = events.findIndex((e) => e.kind === "assistant_text");
    expect(firstDeltaIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThan(firstDeltaIdx);
    expect(events.find((e) => e.kind === "assistant_text")).toMatchObject({ text: "Hello" });
    expect(events.find((e) => e.kind === "thinking")).toMatchObject({ text: "hmm" });
  });

  test("emitDeltas: deltas are never persisted to storage", async () => {
    const storage = createMemoryStorage();
    const { events } = await runAndCollect("run-deltas-storage", {
      emitDeltas: true,
      storage,
    });
    // Live stream saw deltas…
    expect(events.some((e) => e.kind === "assistant_delta")).toBe(true);
    // …but the durable event log did not.
    const persisted = await Effect.runPromise(storage.listEvents("run-deltas-storage"));
    const persistedKinds = persisted.map((e) => e.kind);
    expect(persistedKinds).not.toContain("assistant_delta");
    expect(persistedKinds).not.toContain("thinking_delta");
    expect(persistedKinds).toContain("assistant_text");
  });
});
