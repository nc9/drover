/**
 * #97: a parent that is continued (or resumed) and spawns another subagent must give it a new
 * child run id, with its own run record; never the id (and stored run) of an earlier child.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type AgentSpec, type RunContext } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import { createMemoryStorage, type StorageAdapter } from "@droveragent/storage";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

import { runAgentEffect } from "../src/run.ts";
import { staticRegistry } from "../src/task-tool.ts";
import type { HarnessDeps } from "../src/deps.ts";

const MODEL = "sub-model";
const fakeModel = {
  id: "custom/sub",
  name: "s",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as never;

const msg = (content: AssistantMessage["content"], stop: "stop" | "toolUse"): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "openrouter",
  model: "custom/sub",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: stop,
  timestamp: Date.now(),
});

/**
 * The child always answers. The parent calls `task` when its newest message is a user turn,
 * and answers once it has the task result.
 */
const streamFn: StreamFn = (_m, context) => {
  const last = context.messages.at(-1) as { role: string } | undefined;
  const isChild = (context.systemPrompt ?? "").includes("prompt of child");
  const final = isChild
    ? msg([{ type: "text", text: "child done" }], "stop")
    : last?.role === "user"
      ? msg(
          [
            {
              type: "toolCall",
              id: `c${Math.random()}`,
              name: "task",
              arguments: { agent_type: "child", prompt: "go" },
            },
          ],
          "toolUse",
        )
      : msg([{ type: "text", text: "parent done" }], "stop");
  const s = createAssistantMessageEventStream();
  s.push({ type: "start", partial: final });
  s.push({ type: "done", reason: final.stopReason as "stop" | "toolUse", message: final });
  return s;
};

const agent = (id: string, extra: Partial<AgentSpec> = {}) =>
  defineAgent({
    id,
    systemPrompt: `prompt of ${id}`,
    inputSchema: Type.Object({ q: Type.String() }),
    outputSchema: Type.Unknown(),
    model: MODEL,
    tools: [],
    ...extra,
  } as never);

// The task tool hands a child `{ prompt }` when no explicit input is given.
const child = agent("child", { inputSchema: Type.Object({ prompt: Type.String() }) } as never);
const parent = agent("parent", { subagents: { allowed: ["child"] } } as never);

const ctx = (runId: string): RunContext => ({
  runId,
  depth: 0,
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
});

const deps = (storage: StorageAdapter): HarnessDeps => ({
  sandbox: createNoneSandbox(),
  preResolvedModels: new Map([[MODEL, { model: fakeModel, apiKey: "k" }]]),
  streamFn,
  agentRegistry: staticRegistry({ child }),
  storage,
});

/** Runs the parent fresh, then continues it `continues` times; each invocation spawns one child. */
async function runAndContinue(storage: StorageAdapter, runId: string, continues: number) {
  const first = await Effect.runPromise(
    runAgentEffect({
      spec: parent,
      input: { q: "x" },
      ctx: ctx(runId),
      emit: () => {},
      deps: deps(storage),
    }),
  );
  expect(first.status).toBe("success");
  for (let i = 0; i < continues; i++) {
    // oxlint-disable-next-line no-await-in-loop -- invocations are sequential by definition
    const checkpoint = await Effect.runPromise(storage.loadLatestCheckpoint(runId));
    // oxlint-disable-next-line no-await-in-loop
    const next = await Effect.runPromise(
      runAgentEffect({
        spec: parent,
        input: { q: "x" },
        ctx: ctx(runId),
        emit: () => {},
        deps: deps(storage),
        resumeFrom: checkpoint!,
        appendMessages: [{ content: `follow-up ${i + 1}` }],
      }),
    );
    expect(next.status).toBe("success");
  }
}

describe("subagent run ids across parent invocations (#97)", () => {
  test("a continued parent's next subagent gets a new child run id and its own run record", async () => {
    const storage = createMemoryStorage();
    await runAndContinue(storage, "p97", 2);
    const children = await Effect.runPromise(storage.listRuns({ parentRunId: "p97" } as never));
    const ids = children.map((r) => r.id).toSorted();
    // Three invocations, one child each: three distinct ids, three records.
    expect(ids).toEqual(["p97:1", "p97:2", "p97:3"]);
    for (const r of children) {
      expect(r.parentRunId).toBe("p97");
      expect(r.status).toBe("success");
    }
    // The first child's own events were not wiped or mixed by a later child.
    const firstChildEvents = await Effect.runPromise(storage.listEvents("p97:1"));
    expect(firstChildEvents.filter((e) => e.kind === "run_start")).toHaveLength(1);
  });

  test("without storage, the checkpoint's task calls set where the numbering continues", async () => {
    const events: Array<{ kind: string; childRunId?: string }> = [];
    const prior = msg([{ type: "text", text: "parent done" }], "stop");
    const r = await Effect.runPromise(
      runAgentEffect({
        spec: parent,
        input: { q: "x" },
        ctx: ctx("p97b"),
        emit: (e) => events.push(e as never),
        deps: { ...deps(createMemoryStorage()), storage: undefined } as never,
        resumeFrom: {
          runId: "p97b",
          seq: 3,
          messages: [{ role: "user", content: "x", timestamp: 1 }, prior],
          usage: { inputTokens: 0, outputTokens: 0 },
          toolCalls: ["read", "task", "task"],
          retriesUsed: 0,
          ts: Date.now(),
        },
        appendMessages: [{ content: "follow-up" }],
      }),
    );
    expect(r.status).toBe("success");
    expect(events.filter((e) => e.kind === "subagent_start").map((e) => e.childRunId)).toEqual([
      "p97b:3",
    ]);
  });

  test("a fresh run on a taken run id fails with StorageError and leaves the stored run alone", async () => {
    const storage = createMemoryStorage();
    await runAndContinue(storage, "p97c", 0);
    const before = await Effect.runPromise(storage.loadRun("p97c"));
    const eventsBefore = await Effect.runPromise(storage.listEvents("p97c"));
    const again = await Effect.runPromise(
      Effect.either(
        runAgentEffect({
          spec: parent,
          input: { q: "x" },
          ctx: ctx("p97c"),
          emit: () => {},
          deps: deps(storage),
        }),
      ),
    );
    expect(again._tag).toBe("Left");
    if (again._tag === "Left") {
      expect(again.left).toMatchObject({ _tag: "StorageError", op: "createRun" });
      expect(again.left.message).toContain("already exists");
    }
    expect(await Effect.runPromise(storage.loadRun("p97c"))).toEqual(before);
    expect(await Effect.runPromise(storage.listEvents("p97c"))).toEqual(eventsBefore);
  });

  test("createRun on an existing run id fails loudly", async () => {
    const storage = createMemoryStorage();
    const row = {
      id: "dup",
      agentId: "a",
      specHash: "h",
      status: "running" as const,
      input: {},
      startedAt: 1,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    };
    await Effect.runPromise(storage.createRun(row));
    const again = await Effect.runPromise(Effect.either(storage.createRun(row)));
    expect(again._tag).toBe("Left");
  });
});
