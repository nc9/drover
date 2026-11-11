/**
 * A provider failure is never a success. pi reports HTTP errors as an
 * assistant message with `stopReason: "error"` + `errorMessage` (no throw), and
 * a dead stream can end as an empty `done`. Both used to surface as
 * `status: "success"` with empty text and no error event.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type HarnessEvent, type RunContext } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import type { PreResolvedModel } from "@droveragent/model";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

import { runAgentEffect } from "../src/run.ts";
import type { HarnessDeps } from "../src/deps.ts";

const MODEL_NAME = "provider-error-model";

const fakeModel = {
  id: "custom/pe",
  name: "PE",
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
  model: "custom/pe",
  usage: zeroUsage,
  stopReason: "stop",
  timestamp: Date.now(),
  ...over,
});

const errorStream: StreamFn = () => {
  const s = createAssistantMessageEventStream();
  const error = msg({
    stopReason: "error",
    errorMessage: "402 This request requires more credits, or fewer max_tokens.",
  });
  s.push({ type: "error", reason: "error", error });
  s.end();
  return s;
};

const emptyDoneStream: StreamFn = () => {
  const s = createAssistantMessageEventStream();
  s.push({ type: "start", partial: msg({}) });
  s.push({ type: "done", reason: "stop", message: msg({}) });
  s.end();
  return s;
};

const run = async (
  outputSchema: ReturnType<typeof Type.Object> | ReturnType<typeof Type.Unknown>,
  streamFn: StreamFn,
  extra: Partial<HarnessDeps> = {},
) => {
  const spec = defineAgent({
    id: "provider-error-probe",
    systemPrompt: "probe",
    inputSchema: Type.Object({ q: Type.String() }),
    outputSchema,
    model: MODEL_NAME,
    tools: [],
  });
  const events: HarnessEvent[] = [];
  const ctx: RunContext = {
    runId: "pe-run",
    depth: 0,
    cwd: process.cwd(),
    env: {},
    signal: new AbortController().signal,
  };
  const deps: HarnessDeps = {
    sandbox: createNoneSandbox(),
    preResolvedModels: new Map([[MODEL_NAME, { model: fakeModel, apiKey: "sk-fake" }]]),
    streamFn,
    ...extra,
  };
  const result = await Effect.runPromise(
    runAgentEffect({ spec, input: { q: "hi" }, ctx, emit: (e) => events.push(e), deps }),
  );
  return { result, events };
};

const schemas = {
  open: Type.Unknown(),
  strict: Type.Object({ ok: Type.Boolean() }),
};

describe("provider errors fail the run", () => {
  for (const [name, schema] of Object.entries(schemas)) {
    test(`HTTP 402 (stopReason error) with ${name} output schema: ProviderError, error event, no decode`, async () => {
      const { result, events } = await run(schema, errorStream);
      expect(result.status).toBe("error");
      expect(result.error?.tag).toBe("ProviderError");
      expect(result.error?.message).toBe("provider error 402");
      // Raw provider text stays out of the result and every event.
      expect(JSON.stringify([result.error, events])).not.toContain("more credits");
      expect(result.output).toBeUndefined();
      const err = events.find((e) => e.kind === "error");
      expect(err).toMatchObject({ kind: "error", tag: "ProviderError" });
      expect(events.some((e) => e.kind === "output_validated")).toBe(false);
      expect(events.at(-1)).toMatchObject({ kind: "run_end", status: "error" });
    });

    test(`empty completion (done, no content, zero usage) with ${name} output schema: ProviderError`, async () => {
      const { result, events } = await run(schema, emptyDoneStream);
      expect(result.status).toBe("error");
      expect(result.error?.tag).toBe("ProviderError");
      expect(result.error?.message).toContain("empty");
      expect(events.find((e) => e.kind === "error")).toMatchObject({ tag: "ProviderError" });
      expect(events.some((e) => e.kind === "output_validated")).toBe(false);
    });
  }

  test("includeProviderErrorText opts in to the raw text", async () => {
    const { result, events } = await run(schemas.open, errorStream, {
      includeProviderErrorText: true,
    });
    expect(result.error?.message).toContain(
      "provider error 402: 402 This request requires more credits",
    );
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      message: result.error?.message,
    });
  });
});
