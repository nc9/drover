/**
 * #81: a `providers` value that is not a provider chain fails the run at start with a
 * `SpecConfigError` naming the option; a transport that never yields ends the call instead of
 * hanging; and an unexpected throw still ends the event stream with a failed result.
 */
import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { defineAgent, type HarnessEvent } from "@droveragent/core";
import { createProviderChain, type PreResolvedModel } from "@droveragent/model";

/** A minimal event stream (the facade does not depend on pi-ai): yields `events`, then ends. */
const fakeStream = (events: unknown[], hang = false) => {
  const last = events.at(-1) as { message?: unknown } | undefined;
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
      if (hang) await new Promise(() => {});
    },
    result: () => (hang ? new Promise(() => {}) : Promise.resolve(last?.message)),
  } as never;
};
const createAssistantMessageEventStream = () => fakeStream([], true);

import { runAgent, type RunHandle } from "../src/core.ts";

const spec = defineAgent({
  id: "providers-probe",
  systemPrompt: "probe",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Unknown(),
  model: "m",
  tools: [],
});

const model = {
  id: "custom/probe",
  name: "Probe",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as unknown as PreResolvedModel["model"];
const models = new Map<string, PreResolvedModel>([["m", { model, apiKey: "sk-fake" }]]);

/** Drain events and the result, failing the test (not hanging) after `ms`. */
const settle = async (h: RunHandle<typeof spec>, ms = 3_000) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`run did not settle within ${ms} ms`)), ms);
  });
  try {
    const events: HarnessEvent[] = [];
    const drain = (async () => {
      for await (const e of h.events) events.push(e);
    })();
    const result = await Promise.race([h.result, hung]);
    await Promise.race([drain, hung]);
    return { result, events };
  } finally {
    clearTimeout(timer);
  }
};

describe("providers validation", () => {
  test("next.1's hand-built { forRun, preResolvedModels } fails fast with SpecConfigError", async () => {
    const old = {
      forRun: () => () => createAssistantMessageEventStream(),
      preResolvedModels: () => new Map(),
    };
    const { result, events } = await settle(
      runAgent(spec, { q: "x" }, { sandbox: "disabled", providers: old as never }),
    );
    expect(result.status).toBe("error");
    expect(result.error?.tag).toBe("SpecConfigError");
    expect(result.error?.message).toContain('"providers" option');
    expect(result.error?.message).toContain("createProviderChain");
    expect(result.error?.message).toContain("ProviderEntry");
    expect(events.some((e) => e.kind === "llm_call")).toBe(false);
  });

  test("other values that are not a chain fail the same way", async () => {
    for (const bad of [
      {},
      [],
      "openrouter",
      { forRun: () => {}, preResolvedModels: () => new Map(), providers: [] },
    ]) {
      const { result } = await settle(
        runAgent(spec, { q: "x" }, { sandbox: "disabled", providers: bad as never }),
      );
      expect(result.error?.tag).toBe("SpecConfigError");
    }
  });

  test("a real chain passes the check", async () => {
    const chain = createProviderChain({
      providers: [{ name: "openrouter", models: { "custom/probe": { id: "custom/probe" } } }],
      models: { m: "custom/probe" },
      streams: {
        openrouter: () => {
          const m = {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "ok" }],
            api: "openai-completions" as const,
            provider: "openrouter",
            model: "custom/probe",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop" as const,
            timestamp: 0,
          };
          return fakeStream([
            { type: "start", partial: m },
            { type: "done", reason: "stop", message: m },
          ]);
        },
      },
      apiKeys: { openrouter: "k" },
    });
    const { result } = await settle(
      runAgent(spec, { q: "x" }, { sandbox: "disabled", providers: chain }),
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("success");
  });

  test("an unexpected throw still closes the event stream and returns a failed result", async () => {
    const throwing = {
      providers: ["openrouter"],
      forRun: () => {
        throw new Error("boom in forRun");
      },
      preResolvedModels: () => new Map(),
      balanceSources: () => [],
    };
    const { result } = await settle(
      runAgent(spec, { q: "x" }, { sandbox: "disabled", providers: throwing as never }),
    );
    expect(result.status).toBe("error");
    expect(result.error?.tag).toBe("InternalError");
    expect(result.error?.message).toContain("boom in forRun");
  });
});

describe("a transport that never yields", () => {
  test("a stream with no events ends the call after streamIdleTimeoutMs", async () => {
    const { result } = await settle(
      runAgent(
        spec,
        { q: "x" },
        {
          sandbox: "disabled",
          models,
          streamIdleTimeoutMs: 50,
          streamFn: () => createAssistantMessageEventStream(),
        },
      ),
    );
    expect(result.status).toBe("error");
    expect(result.error?.tag).toBe("ProviderError");
  });

  test("a transport whose open never settles ends the call too", async () => {
    const { result } = await settle(
      runAgent(
        spec,
        { q: "x" },
        {
          sandbox: "disabled",
          models,
          streamIdleTimeoutMs: 50,
          streamFn: () => new Promise(() => {}),
        },
      ),
    );
    expect(result.status).toBe("error");
  });
});

describe("resumeAgent before the run starts", () => {
  test("a storage adapter that throws still ends the events and resolves the result", async () => {
    const { resumeAgent } = await import("../src/core.ts");
    const storage = {
      loadRun: () => {
        throw new Error("adapter exploded");
      },
    } as never;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("resume did not settle")), 3_000);
    });
    try {
      const h = resumeAgent(spec, "run-x", { sandbox: "disabled", storage });
      const drain = (async () => {
        for await (const _e of h.events) {
          /* drain */
        }
      })();
      const r = await Promise.race([h.result, hung]);
      await Promise.race([drain, hung]);
      expect(r.status).toBe("error");
      expect(r.error?.tag).toBe("InternalError");
      expect(r.error?.message).toContain("adapter exploded");
    } finally {
      clearTimeout(timer);
    }
  });
});
