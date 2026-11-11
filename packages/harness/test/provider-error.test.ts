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
import { createMemoryStorage } from "@droveragent/storage";
import {
  createAssistantMessageEventStream,
  streamSimple,
  type AssistantMessage,
} from "@mariozechner/pi-ai";
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";

import { runAgentEffect } from "../src/run.ts";
import { providerFailure, scrubProviderErrorText } from "../src/provider-failure.ts";
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
  streamFn: StreamFn | undefined,
  extra: Partial<HarnessDeps> = {},
  model: PreResolvedModel["model"] = fakeModel,
  lifecycle?: Parameters<typeof defineAgent>[0]["lifecycle"],
) => {
  const spec = defineAgent({
    id: "provider-error-probe",
    systemPrompt: "probe",
    inputSchema: Type.Object({ q: Type.String() }),
    outputSchema,
    model: MODEL_NAME,
    tools: [],
    ...(lifecycle ? { lifecycle } : {}),
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
    preResolvedModels: new Map([[MODEL_NAME, { model, apiKey: "sk-fake" }]]),
    ...(streamFn ? { streamFn } : {}),
    ...extra,
  };
  const result = await Effect.runPromise(
    runAgentEffect({ spec, input: { q: "hi" }, ctx, emit: (e) => events.push(e), deps }),
  );
  return { result, events };
};

// The SDK retries 5xx by default; the transport stays real, only retries are off.
const noRetry: StreamFn = (model, context, options) =>
  streamSimple(model, context, { ...options, maxRetries: 0 });

const am = (over: Record<string, unknown>) => ({
  role: "assistant",
  stopReason: "stop",
  ...over,
});

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

  test("a tool-call-only first turn is not an empty completion", async () => {
    let call = 0;
    const toolThenText: StreamFn = () => {
      call += 1;
      const s = createAssistantMessageEventStream();
      const m =
        call === 1
          ? msg({
              stopReason: "toolUse",
              content: [{ type: "toolCall", id: "c1", name: "nope", arguments: {} }],
            })
          : msg({ content: [{ type: "text", text: "done" }] });
      s.push({ type: "start", partial: m });
      s.push({ type: "done", reason: m.stopReason as "stop", message: m });
      s.end();
      return s;
    };
    const { result } = await run(schemas.open, toolThenText);
    expect(call).toBe(2);
    expect(result.status).toBe("success");
    expect(result.finalText).toBe("done");
  });

  test("a provider error in the postSuccess closing turn fails the run", async () => {
    let call = 0;
    const okThenError: StreamFn = (...args) => {
      call += 1;
      if (call > 1) return errorStream(...args);
      const s = createAssistantMessageEventStream();
      const m = msg({ content: [{ type: "text", text: '{"ok":true}' }] });
      s.push({ type: "start", partial: m });
      s.push({ type: "done", reason: "stop", message: m });
      s.end();
      return s;
    };
    const { result, events } = await run(schemas.strict, okThenError, {}, fakeModel, {
      postSuccess: [{ kind: "prompt", text: "now lint" }],
    });
    expect(call).toBe(2);
    expect(result.status).toBe("error");
    expect(result.error).toEqual({ tag: "ProviderError", message: "provider error 402" });
    expect(events.find((e) => e.kind === "error")).toMatchObject({ tag: "ProviderError" });
  });

  test("storage (run row, events, checkpoints) carries no provider text by default", async () => {
    const storage = createMemoryStorage();
    const { result } = await run(schemas.open, errorStream, { storage });
    expect(result.error?.tag).toBe("ProviderError");
    await new Promise((r) => setTimeout(r, 10)); // checkpoint writes are fire-and-forget
    const stored = await Effect.runPromise(
      Effect.all([
        storage.loadRun("pe-run"),
        storage.listEvents("pe-run"),
        storage.loadLatestCheckpoint("pe-run"),
      ]),
    );
    expect(stored[0]?.status).toBe("error");
    expect(stored[2]).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain("more credits");
  });
});

describe("provider errors over a real HTTP transport (local server, pi-ai OpenAI client)", () => {
  const SECRET = "quoted prompt words: the hostile page said hello";
  const withServer = async (
    status: number,
    body: (s: ReturnType<typeof Bun.serve>) => Promise<void>,
  ): Promise<void> => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: { message: SECRET, code: status } }, { status }),
    });
    try {
      await body(server);
    } finally {
      server.stop(true);
    }
  };
  const modelAt = (s: ReturnType<typeof Bun.serve>): PreResolvedModel["model"] =>
    ({ ...fakeModel, baseUrl: `http://127.0.0.1:${s.port}/v1` }) as PreResolvedModel["model"];

  for (const status of [402, 401, 503]) {
    for (const [name, schema] of Object.entries(schemas)) {
      test(`HTTP ${status}, ${name} schema: provider error ${status}, no body text anywhere`, async () => {
        await withServer(status, async (server) => {
          const storage = createMemoryStorage();
          const { result, events } = await run(schema, noRetry, { storage }, modelAt(server));
          expect(result.status).toBe("error");
          expect(result.error).toEqual({
            tag: "ProviderError",
            message: `provider error ${status}`,
          });
          const errIdx = events.findIndex((e) => e.kind === "error");
          expect(errIdx).toBeGreaterThanOrEqual(0);
          expect(errIdx).toBeLessThan(events.findIndex((e) => e.kind === "run_end"));
          await new Promise((r) => setTimeout(r, 10));
          const cp = await Effect.runPromise(storage.loadLatestCheckpoint("pe-run"));
          expect(JSON.stringify([result, events, cp])).not.toContain("hostile page");
        });
      });
    }
  }

  test("HTTP 402 with the default transport (no streamFn) and includeProviderErrorText", async () => {
    await withServer(402, async (server) => {
      const { result } = await run(
        schemas.open,
        undefined,
        { includeProviderErrorText: true },
        modelAt(server),
      );
      expect(result.error?.message).toStartWith("provider error 402: 402 ");
      expect(result.error?.message).toContain("hostile page");
    });
  });
});

describe("providerFailure classification", () => {
  test("tool-call-only is an answer; thinking-only and blank text are empty", () => {
    expect(
      providerFailure(
        am({ content: [{ type: "toolCall", id: "c", name: "t", arguments: {} }] }),
        false,
      ),
    ).toBeNull();
    expect(providerFailure(am({ content: [{ type: "text", text: "hi" }] }), false)).toBeNull();
    expect(
      providerFailure(am({ content: [{ type: "thinking", thinking: "hmm" }] }), false),
    ).toContain("empty");
    expect(providerFailure(am({ content: [{ type: "text", text: "  " }] }), false)).toContain(
      "empty",
    );
    expect(providerFailure(null, false)).toContain("no assistant message");
    expect(providerFailure(am({ stopReason: "aborted", content: [] }), false)).toBeNull();
  });

  test("status comes only from the leading code, never from a number inside the text", () => {
    expect(
      providerFailure(am({ stopReason: "error", errorMessage: "529 Overloaded" }), false),
    ).toBe("provider error 529");
    expect(
      providerFailure(
        am({ stopReason: "error", errorMessage: "Provider finish_reason: page 404 quoted" }),
        false,
      ),
    ).toBe("provider error");
  });

  test("scrubProviderErrorText replaces raw errorMessage in checkpoint history", () => {
    const history = [
      { role: "user", content: "hi", timestamp: 1 },
      am({ stopReason: "error", errorMessage: "402 quoted secret", content: [] }),
      am({ stopReason: "aborted", errorMessage: "Request was aborted", content: [] }),
    ] as unknown as AgentMessage[];
    const out = scrubProviderErrorText(history);
    expect(out[0]).toBe(history[0]!);
    expect((out[1] as { errorMessage?: string }).errorMessage).toBe("provider error 402");
    expect((out[2] as { errorMessage?: string }).errorMessage).toBe("aborted");
    expect(JSON.stringify(out)).not.toContain("secret");
  });
});
