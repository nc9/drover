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
} from "@earendil-works/pi-ai/compat";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";

import { runAgentEffect } from "../src/run.ts";
import { staticRegistry } from "../src/task-tool.ts";
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

/** Checkpoint writes are fire-and-forget: poll until one lands (2 s cap). */
const latestCheckpoint = async (
  storage: ReturnType<typeof createMemoryStorage>,
  runId: string,
  triesLeft = 200,
): Promise<unknown> => {
  const cp = await Effect.runPromise(storage.loadLatestCheckpoint(runId));
  if (cp || triesLeft <= 0) return cp;
  await new Promise((r) => setTimeout(r, 10));
  return latestCheckpoint(storage, runId, triesLeft - 1);
};

const d = (details: Record<string, unknown>) => ({ type: "provider_failure", details });

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
      expect(result.error?.status).toBe(402);
      // Raw provider text stays out of the result and every event.
      expect(JSON.stringify([result.error, events])).not.toContain("more credits");
      expect(result.output).toBeUndefined();
      const err = events.find((e) => e.kind === "error");
      expect(err).toMatchObject({ kind: "error", tag: "ProviderError", status: 402 });
      expect(events.some((e) => e.kind === "output_validated")).toBe(false);
      expect(events.at(-1)).toMatchObject({ kind: "run_end", status: "error" });
    });

    test(`empty completion (done, no content, zero usage) with ${name} output schema: ProviderError`, async () => {
      const { result, events } = await run(schema, emptyDoneStream);
      expect(result.status).toBe("error");
      expect(result.error?.tag).toBe("ProviderError");
      expect(result.error?.message).toContain("empty");
      expect(result.error?.status).toBeUndefined();
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
    expect(result.error).toEqual({
      tag: "ProviderError",
      message: "provider error 402",
      status: 402,
    });
    expect(events.find((e) => e.kind === "error")).toMatchObject({ tag: "ProviderError" });
  });

  test("an empty closing postSuccess reply is not a failure (only stopReason error is)", async () => {
    let call = 0;
    const okThenEmpty: StreamFn = () => {
      call += 1;
      const s = createAssistantMessageEventStream();
      const m = call === 1 ? msg({ content: [{ type: "text", text: '{"ok":true}' }] }) : msg({});
      s.push({ type: "start", partial: m });
      s.push({ type: "done", reason: "stop", message: m });
      s.end();
      return s;
    };
    const { result } = await run(schemas.strict, okThenEmpty, {}, fakeModel, {
      postSuccess: [{ kind: "prompt", text: "now lint" }],
    });
    expect(call).toBe(2);
    expect(result.status).toBe("success");
    expect(result.output).toEqual({ ok: true });
  });

  /** Turn 1: a tool call; turn 2: `second`. */
  const toolThen = (second: AssistantMessage): StreamFn => {
    let call = 0;
    return () => {
      call += 1;
      const s = createAssistantMessageEventStream();
      const m =
        call === 1
          ? msg({
              stopReason: "toolUse",
              content: [{ type: "toolCall", id: "c1", name: "nope", arguments: {} }],
              usage: { ...zeroUsage, output: 5 },
            })
          : second;
      s.push({ type: "start", partial: m });
      s.push({ type: "done", reason: m.stopReason as "stop", message: m });
      s.end();
      return s;
    };
  };

  test("an empty end_turn with output tokens after tool work stays a success", async () => {
    const { result } = await run(
      schemas.open,
      toolThen(msg({ content: [], usage: { ...zeroUsage, output: 7 } })),
    );
    expect(result.status).toBe("success");
    expect(result.finalText).toBe("");
  });

  test("a dead stream (empty, zero output tokens) after tool work is a ProviderError", async () => {
    const { result } = await run(schemas.open, toolThen(msg({ content: [] })));
    expect(result.status).toBe("error");
    expect(result.error?.message).toBe("provider returned an empty completion (no content)");
  });

  test("stopReason length with thinking only: model hit max tokens before answering", async () => {
    const lengthThinking: StreamFn = () => {
      const s = createAssistantMessageEventStream();
      const m = msg({
        stopReason: "length",
        content: [{ type: "thinking", thinking: "still thinking" }],
        usage: { ...zeroUsage, output: 8_192 },
      });
      s.push({ type: "start", partial: m });
      s.push({ type: "done", reason: "length", message: m });
      s.end();
      return s;
    };
    const { result } = await run(schemas.open, lengthThinking);
    expect(result.status).toBe("error");
    expect(result.error).toEqual({
      tag: "ProviderError",
      message: "model hit max tokens before answering",
    });
  });

  test("a subagent child hitting 402: the parent sees a status-only tool error", async () => {
    const child = defineAgent({
      id: "child",
      systemPrompt: "child-agent",
      inputSchema: Type.Object({ prompt: Type.String() }),
      outputSchema: Type.Unknown(),
      model: MODEL_NAME,
      tools: [],
    });
    const parent = defineAgent({
      id: "parent",
      systemPrompt: "parent-agent",
      inputSchema: Type.Object({ q: Type.String() }),
      outputSchema: Type.Unknown(),
      model: MODEL_NAME,
      tools: [],
      subagents: { allowed: ["child"] },
    });
    let parentCalls = 0;
    const streamFn: StreamFn = (model, context, options) => {
      if (String(context.systemPrompt).includes("child-agent"))
        return errorStream(model, context, options);
      parentCalls += 1;
      const s = createAssistantMessageEventStream();
      const m =
        parentCalls === 1
          ? msg({
              stopReason: "toolUse",
              content: [
                {
                  type: "toolCall",
                  id: "t1",
                  name: "task",
                  arguments: { agent_type: "child", prompt: "go" },
                },
              ],
              usage: { ...zeroUsage, output: 5 },
            })
          : msg({ content: [{ type: "text", text: "parent done" }] });
      s.push({ type: "start", partial: m });
      s.push({ type: "done", reason: m.stopReason as "stop", message: m });
      s.end();
      return s;
    };
    const events: HarnessEvent[] = [];
    const result = await Effect.runPromise(
      runAgentEffect({
        spec: parent,
        input: { q: "hi" },
        ctx: {
          runId: "parent-run",
          depth: 0,
          cwd: process.cwd(),
          env: {},
          signal: new AbortController().signal,
        },
        emit: (e) => events.push(e),
        deps: {
          sandbox: createNoneSandbox(),
          preResolvedModels: new Map([[MODEL_NAME, { model: fakeModel, apiKey: "sk-fake" }]]),
          streamFn,
          agentRegistry: staticRegistry({ child }),
        },
      }),
    );
    expect(result.status).toBe("success");
    expect(result.finalText).toBe("parent done");
    const end = events.find((e) => e.kind === "tool_call_end" && e.toolName === "task") as
      | Extract<HarnessEvent, { kind: "tool_call_end" }>
      | undefined;
    expect(end?.result.isError).toBe(true);
    expect(end?.result.content).toBe(
      "subagent child finished with status=error: provider error 402",
    );
    expect(events.find((e) => e.kind === "subagent_end")).toMatchObject({ status: "error" });
    expect(JSON.stringify(events)).not.toContain("more credits");
  });

  test("storage (run row, events, checkpoints) carries no provider text by default", async () => {
    const storage = createMemoryStorage();
    const { result } = await run(schemas.open, errorStream, { storage });
    expect(result.error?.tag).toBe("ProviderError");
    expect(await latestCheckpoint(storage, "pe-run")).not.toBeNull();
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

describe("error.details on the run (#92)", () => {
  test("a chain failure's details reach RunResult.error and the error event", async () => {
    const chainFail: StreamFn = () => {
      const s = createAssistantMessageEventStream();
      const error = msg({
        stopReason: "error",
        errorMessage: "all providers failed: SECRET",
        diagnostics: [
          {
            type: "provider_failure",
            timestamp: 0,
            details: {
              provider: "openrouter",
              failureClass: "rate_limited",
              status: 429,
              code: "insufficient_quota",
              type: "rate_limit_error",
              retryAfterMs: 2000,
            },
          },
        ],
      } as Partial<AssistantMessage>);
      s.push({ type: "error", reason: "error", error });
      s.end();
      return s;
    };
    const { result, events } = await run(Type.Unknown(), chainFail);
    const details = { code: "insufficient_quota", type: "rate_limit_error", retryAfterMs: 2000 };
    expect(result.error).toMatchObject({ tag: "ProviderError", status: 429, details });
    const ev = events.find((e) => e.kind === "error") as { details?: unknown };
    expect(ev.details).toEqual(details);
    expect(JSON.stringify([result, events])).not.toContain("SECRET");
  });

  test("a plain provider error has no details", async () => {
    const { result, events } = await run(Type.Unknown(), errorStream);
    expect(result.error).not.toHaveProperty("details");
    expect(events.find((e) => e.kind === "error")).not.toHaveProperty("details");
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
            status,
          });
          const errIdx = events.findIndex((e) => e.kind === "error");
          expect(errIdx).toBeGreaterThanOrEqual(0);
          expect(errIdx).toBeLessThan(events.findIndex((e) => e.kind === "run_end"));
          const cp = await latestCheckpoint(storage, "pe-run");
          expect(cp).not.toBeNull();
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
      providerFailure(am({ content: [{ type: "thinking", thinking: "hmm" }] }), false)?.message,
    ).toContain("empty");
    expect(
      providerFailure(am({ content: [{ type: "text", text: "  " }] }), false)?.message,
    ).toContain("empty");
    expect(providerFailure(null, false)?.message).toContain("no assistant message");
    // Not the first assistant message, output tokens > 0: an empty end after tool work.
    expect(providerFailure(am({ content: [], usage: { output: 3 } }), false, false)).toBeNull();
    expect(
      providerFailure(am({ content: [], usage: { output: 0 } }), false, false)?.message,
    ).toContain("empty");
    expect(
      providerFailure(
        am({
          stopReason: "length",
          content: [{ type: "thinking", thinking: "x" }],
          usage: { output: 9 },
        }),
        false,
        false,
      )?.message,
    ).toBe("model hit max tokens before answering");
    expect(providerFailure(am({ stopReason: "aborted", content: [] }), false)).toBeNull();
  });

  test("status comes only from the leading code, never from a number inside the text", () => {
    expect(
      providerFailure(am({ stopReason: "error", errorMessage: "529 Overloaded" }), false),
    ).toEqual({ message: "provider error 529", status: 529 });
    expect(
      providerFailure(
        am({ stopReason: "error", errorMessage: "Provider finish_reason: page 404 quoted" }),
        false,
      ),
    ).toEqual({ message: "provider error" });
  });

  test("a provider chain's diagnostics list every attempt, structured fields only", () => {
    const chainMsg = am({
      stopReason: "error",
      errorMessage: "all providers failed: SECRET text",
      diagnostics: [
        d({ provider: "openrouter", failureClass: "credits_exhausted", status: 402 }),
        d({ provider: "cf", failureClass: "region_refused", status: 403, code: "unsupported_x" }),
        d({ provider: "evil name with spaces", failureClass: "other", status: 500 }),
        { type: "something_else", details: { provider: "x" } },
      ],
    });
    expect(providerFailure(chainMsg, false)).toEqual({
      message:
        "provider error 403 (openrouter: credits_exhausted 402; cf: region_refused 403 unsupported_x)",
      status: 403,
      // "unsupported_x" is a token but not on the chain's code allow-list: no details.
    });
    expect(providerFailure(chainMsg, true)?.message).toEndWith(
      ": all providers failed: SECRET text",
    );
    const scrubbed = scrubProviderErrorText([chainMsg] as unknown as AgentMessage[]);
    expect(JSON.stringify(scrubbed)).not.toContain("SECRET");
  });

  test("details carry the last attempt's code, type and retryAfterMs; never text (#92)", () => {
    const withAll = am({
      stopReason: "error",
      errorMessage: "SECRET",
      diagnostics: [
        d({ provider: "a", failureClass: "provider_error", status: 500, type: "api_error" }),
        d({
          provider: "b",
          failureClass: "rate_limited",
          status: 429,
          code: "insufficient_quota",
          type: "rate_limit_error",
          retryAfterMs: 1500.4,
        }),
      ],
    });
    expect(providerFailure(withAll, false)?.details).toEqual({
      code: "insufficient_quota",
      type: "rate_limit_error",
      retryAfterMs: 1500,
    });
    const hostile = am({
      stopReason: "error",
      diagnostics: [
        d({
          provider: "a",
          failureClass: "other",
          status: 500,
          type: "ignore previous instructions",
          code: "<b>x</b>",
          retryAfterMs: Number.MAX_SAFE_INTEGER,
        }),
      ],
    });
    expect(providerFailure(hostile, false)).not.toHaveProperty("details");
    // A code must be on the chain's allow-list, not just token-shaped.
    expect(
      providerFailure(
        am({
          stopReason: "error",
          diagnostics: [d({ provider: "a", failureClass: "other", status: 400, code: "made_up" })],
        }),
        false,
      ),
    ).not.toHaveProperty("details");
    // Without a chain only the status is known.
    expect(
      providerFailure(am({ stopReason: "error", errorMessage: "429 slow" }), false),
    ).not.toHaveProperty("details");
  });

  test("details are the last attempt's only: earlier attempts' fields never leak forward (#92)", () => {
    // First attempt knows type and a wait; the last knows nothing: no details at all.
    const lastBare = am({
      stopReason: "error",
      diagnostics: [
        d({
          provider: "a",
          failureClass: "rate_limited",
          status: 429,
          type: "rate_limit_error",
          retryAfterMs: 3000,
        }),
        d({ provider: "b", failureClass: "provider_error", status: 503 }),
      ],
    });
    const bare = providerFailure(lastBare, false);
    expect(bare?.status).toBe(503);
    expect(bare).not.toHaveProperty("details");

    // A same-provider retry (429 with a wait), then a different final failure: the final's.
    const retried = am({
      stopReason: "error",
      diagnostics: [
        d({
          provider: "a",
          failureClass: "rate_limited",
          status: 429,
          type: "rate_limit_error",
          retryAfterMs: 1000,
        }),
        d({
          provider: "a",
          failureClass: "credits_exhausted",
          status: 402,
          code: "insufficient_quota",
          type: "insufficient_quota",
        }),
      ],
    });
    expect(providerFailure(retried, false)).toMatchObject({
      status: 402,
      details: { code: "insufficient_quota", type: "insufficient_quota" },
    });
    expect(providerFailure(retried, false)?.details).not.toHaveProperty("retryAfterMs");
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

test("usageByProvider keys are data: a provider named __proto__ is an own key", async () => {
  const proto: StreamFn = () => {
    const s = createAssistantMessageEventStream();
    const m = msg({
      provider: "__proto__" as never,
      content: [{ type: "text", text: "hi" }],
      usage: { ...zeroUsage, input: 3, output: 2, totalTokens: 5 },
    });
    s.push({ type: "start", partial: m });
    s.push({ type: "done", reason: "stop", message: m });
    s.end();
    return s;
  };
  const { result } = await run(schemas.open, proto);
  expect(result.status).toBe("success");
  expect(Object.hasOwn(result.usageByProvider!, "__proto__")).toBe(true);
  expect(result.usageByProvider!["__proto__"]).toEqual({ inputTokens: 3, outputTokens: 2 });
});
