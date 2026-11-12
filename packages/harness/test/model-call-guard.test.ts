/** `beforeModelCall`: a plugin can refuse a model call; the run ends `error` with its tag and message. */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import {
  defineAgent,
  type HarnessEvent,
  type HarnessPlugin,
  type RunContext,
} from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import { createMemoryStorage } from "@droveragent/storage";
import type { PreResolvedModel } from "@droveragent/model";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";

// Relative import: harness does not depend on plugins.
import { balancePreflightPlugin } from "../../plugins/src/balance-preflight.ts";
import { runAgentEffect } from "../src/run.ts";

const model = {
  id: "custom/g",
  name: "g",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as unknown as PreResolvedModel["model"];
const msg = (
  content: AssistantMessage["content"],
  stop: "stop" | "toolUse" | "aborted",
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "openrouter",
  model: "custom/g",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
  },
  stopReason: stop,
  timestamp: Date.now(),
});

/** Counts calls that reach a provider; honours the abort signal like a real transport. */
function transport() {
  const state = { reached: 0 };
  const streamFn: StreamFn = (_m, _c, options) => {
    const s = createAssistantMessageEventStream();
    if (options?.signal?.aborted) {
      s.push({ type: "error", reason: "aborted", error: msg([], "aborted") });
      return s;
    }
    const m =
      state.reached++ === 0
        ? msg(
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
        : msg([{ type: "text", text: "done" }], "stop");
    s.push({ type: "start", partial: m });
    s.push({ type: "done", reason: m.stopReason as "stop" | "toolUse", message: m });
    return s;
  };
  return { state, streamFn };
}

const run = async (plugins: HarnessPlugin[], compact = false) => {
  const { state, streamFn } = transport();
  const events: HarnessEvent[] = [];
  const ctx: RunContext = {
    runId: "r",
    depth: 0,
    cwd: process.cwd(),
    env: {},
    signal: new AbortController().signal,
  };
  const result = await Effect.runPromise(
    runAgentEffect({
      spec: defineAgent({
        id: "g",
        systemPrompt: "p",
        inputSchema: Type.Object({ q: Type.String() }),
        outputSchema: Type.Unknown(),
        model: "m",
        tools: ["read"],
        plugins,
        ...(compact
          ? {
              compaction: {
                strategy: ["drop-tool-results" as const],
                preserve: { firstUserTurn: true, recentTurns: 0 },
                trigger: { kind: "input_tokens" as const, value: 1 },
              },
            }
          : {}),
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
  return { result, events, state };
};

const guard = (
  decide: (
    n: number,
    costUsd: number,
  ) => { kind: "allow" } | { kind: "refuse"; tag: string; message: string },
): HarnessPlugin => ({
  id: "guard",
  beforeModelCall: (info) => Effect.succeed(decide(info.callNumber, info.usage.costUsd ?? 0)),
});

describe("beforeModelCall", () => {
  test("a refusal before the first call: run ends error with the tag and message, no model call is made", async () => {
    const { result, events, state } = await run([
      guard(() => ({
        kind: "refuse",
        tag: "InsufficientBalance",
        message: "openrouter balance $0.10 is below the $1.00 needed",
      })),
    ]);
    expect(result.status).toBe("error");
    expect(result.error).toEqual({
      tag: "InsufficientBalance",
      message: "openrouter balance $0.10 is below the $1.00 needed",
    });
    expect(state.reached).toBe(0);
    expect(events.find((e) => e.kind === "error")).toMatchObject({ tag: "InsufficientBalance" });
    expect(events.at(-1)).toMatchObject({ kind: "run_end", status: "error" });
  });

  test("a refusal on a later call sees the usage so far; earlier work stays in the result", async () => {
    const seen: number[] = [];
    const { result, state } = await run([
      guard(
        (n, cost) => (
          seen.push(cost),
          n === 2 ? { kind: "refuse", tag: "Stop", message: "no more" } : { kind: "allow" }
        ),
      ),
    ]);
    expect(seen).toEqual([0, 0.5]);
    expect(result.status).toBe("error");
    expect(result.error?.tag).toBe("Stop");
    expect(state.reached).toBe(1);
    expect(result.toolCalls).toEqual(["read"]);
  });

  test("allow changes nothing; a throwing or dying hook is swallowed (fails open)", async () => {
    const dying: HarnessPlugin = {
      id: "dying",
      beforeModelCall: () => Effect.die(new Error("bug")),
    };
    const throwing: HarnessPlugin = {
      id: "throwing",
      beforeModelCall: () => {
        throw new Error("bug");
      },
    };
    for (const plugins of [[guard(() => ({ kind: "allow" }))], [dying], [throwing]]) {
      const { result, state } = await run(plugins);
      expect(result.status).toBe("success");
      expect(state.reached).toBe(2);
    }
  });

  test("the guard runs before compaction: a refused call spends nothing, not even a compaction pass", async () => {
    const refuseSecond = guard((n) =>
      n === 2 ? { kind: "refuse", tag: "Stop", message: "no more" } : { kind: "allow" },
    );
    // Control: allowed, the second call's context is compacted.
    const allowed = await run([guard(() => ({ kind: "allow" }))], true);
    expect(allowed.events.some((e) => e.kind === "compaction")).toBe(true);
    // Refused on call 2: no compaction pass ran for it.
    const refused = await run([refuseSecond], true);
    expect(refused.result.error?.tag).toBe("Stop");
    expect(refused.events.some((e) => e.kind === "compaction")).toBe(false);
    expect(refused.state.reached).toBe(1);
  });
});

describe("beforeModelCall refusal round 2", () => {
  /** A transport that never looks at the abort signal: every call it gets counts. */
  const deafTransport = () => {
    const state = { calls: 0 };
    const streamFn: StreamFn = () => {
      const n = ++state.calls;
      const s = createAssistantMessageEventStream();
      const m =
        n === 1
          ? msg(
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
          : msg([{ type: "text", text: "done" }], "stop");
      s.push({ type: "start", partial: m });
      s.push({ type: "done", reason: m.stopReason as "stop" | "toolUse", message: m });
      return s;
    };
    return { state, streamFn };
  };

  const runDeaf = async (
    plugins: HarnessPlugin[],
    lifecycle?: Parameters<typeof defineAgent>[0]["lifecycle"],
  ) => {
    const { state, streamFn } = deafTransport();
    const checkpoints: number[] = [];
    const storage = createMemoryStorage();
    const spied = {
      ...storage,
      saveCheckpoint: (c: Parameters<typeof storage.saveCheckpoint>[0]) => {
        checkpoints.push(c.seq);
        return storage.saveCheckpoint(c);
      },
    };
    const events: HarnessEvent[] = [];
    const result = await Effect.runPromise(
      runAgentEffect({
        spec: defineAgent({
          id: "g2",
          systemPrompt: "p",
          inputSchema: Type.Object({ q: Type.String() }),
          outputSchema: Type.Unknown(),
          model: "m",
          tools: ["read"],
          plugins,
          ...(lifecycle ? { lifecycle } : {}),
        }),
        input: { q: "x" },
        ctx: {
          runId: "r2",
          depth: 0,
          cwd: process.cwd(),
          env: {},
          signal: new AbortController().signal,
        },
        emit: (e) => events.push(e),
        deps: {
          sandbox: createNoneSandbox(),
          preResolvedModels: new Map([["m", { model, apiKey: "k" }]]),
          streamFn,
          storage: spied,
        },
      }),
    );
    return { result, events, state, checkpoints };
  };

  test("a refused call never reaches the transport, even one that ignores the abort signal", async () => {
    const first = await runDeaf([guard(() => ({ kind: "refuse", tag: "T", message: "m" }))]);
    expect(first.state.calls).toBe(0);
    expect(first.result.status).toBe("error");
    const second = await runDeaf([
      guard((n) => (n === 2 ? { kind: "refuse", tag: "T", message: "m" } : { kind: "allow" })),
    ]);
    expect(second.state.calls).toBe(1);
  });

  test("the refused call adds no usage, no turn and no checkpoint", async () => {
    const allowed = await runDeaf([guard(() => ({ kind: "allow" }))]);
    const refused = await runDeaf([
      guard((n) => (n === 2 ? { kind: "refuse", tag: "T", message: "m" } : { kind: "allow" })),
    ]);
    // one real call (turn 1) happened before the refusal
    expect(refused.result.turns).toBe(1);
    expect(refused.result.usage.costUsd).toBe(0.5);
    expect(refused.checkpoints).toEqual([1]);
    expect(allowed.result.turns).toBe(2);
    // only the real call's usage event; nothing for the refused one
    expect(refused.events.filter((e) => e.kind === "usage").length).toBe(1);
    expect(allowed.events.filter((e) => e.kind === "usage").length).toBe(2);
  });

  test("a refusal during the postSuccess continuation: run ends error, the refused call is never sent", async () => {
    // Balance is fine for the main run and gone by the 3rd call (the closing post-processing turn).
    const seen = { lookups: 0 };
    const preflight = balancePreflightPlugin({
      sources: [
        {
          provider: "openrouter",
          balance: async () => ({ remainingUsd: ++seen.lookups === 1 ? 100 : 0 }),
        },
      ],
      estimateUsd: 5, // $1.00 spent by call 3 (two calls at $0.50), $4.00 still expected
      everyNCalls: 3,
      cacheMs: 0,
    });
    const { result, state, events } = await runDeaf([preflight], {
      postSuccess: [{ kind: "prompt", text: "now summarise" }],
    });
    expect(state.calls).toBe(2); // calls 1 and 2 of the main loop; call 3 refused
    expect(result.status).toBe("error");
    expect(result.error?.tag).toBe("InsufficientBalance");
    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);
  });
});

describe("beforeModelCall on a continuation (#2)", () => {
  const continued = async (plugins: HarnessPlugin[]) => {
    const { state, streamFn } = transport();
    state.reached = 1; // answer directly
    const prior = msg([{ type: "text", text: "first answer" }], "stop");
    const result = await Effect.runPromise(
      runAgentEffect({
        spec: defineAgent({
          id: "g",
          systemPrompt: "p",
          inputSchema: Type.Object({ q: Type.String() }),
          outputSchema: Type.Unknown(),
          model: "m",
          tools: ["read"],
          plugins,
        }),
        input: { q: "x" },
        ctx: {
          runId: "cont",
          depth: 0,
          cwd: process.cwd(),
          env: {},
          signal: new AbortController().signal,
        },
        emit: () => {},
        deps: {
          sandbox: createNoneSandbox(),
          preResolvedModels: new Map([["m", { model, apiKey: "k" }]]),
          streamFn,
        },
        resumeFrom: {
          runId: "cont",
          seq: 2,
          messages: [
            { role: "user", content: "x", timestamp: 1 },
            prior,
            { role: "user", content: "and now a follow-up", timestamp: 2 },
          ],
          usage: { inputTokens: 10, outputTokens: 10, costUsd: 2 },
          toolCalls: [],
          retriesUsed: 0,
          ts: Date.now(),
        },
      }),
    );
    return { result, state };
  };

  test("the first call of a continuation is callNumber 1 with the run's usage so far", async () => {
    const seen: Array<[number, number]> = [];
    const { result, state } = await continued([
      guard((n, cost) => (seen.push([n, cost]), { kind: "allow" })),
    ]);
    expect(result.status).toBe("success");
    expect(seen[0]).toEqual([1, 2]);
    expect(state.reached).toBe(2);
  });

  test("a refusal on a continuation's first call ends error and makes no call", async () => {
    const { result, state } = await continued([
      guard(() => ({ kind: "refuse", tag: "InsufficientBalance", message: "top up" })),
    ]);
    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ tag: "InsufficientBalance", message: "top up" });
    expect(state.reached).toBe(1);
  });
});
