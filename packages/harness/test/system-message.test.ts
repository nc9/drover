/**
 * pi 1.x ignores `AgentContext.systemPrompt`: the prompt reaches the model only as a
 * leading system message. These tests assert the prompt text (and the tool declarations)
 * arrive in every loop, exactly once, and that pre-migration checkpoints still resume.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type RunContext, type RunResult } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import { createMemoryStorage, type CheckpointRow } from "@droveragent/storage";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
} from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { runAgentEffect } from "../src/run.ts";

const model = {
  id: "m",
  name: "m",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://test.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
} as never;

const reply = (text: string | null): AssistantMessage => ({
  role: "assistant",
  content:
    text === null
      ? [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/nope" } }]
      : [{ type: "text", text }],
  api: "openai-completions",
  provider: "test",
  model: "m",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: text === null ? "toolUse" : "stop",
  timestamp: 0,
});

type Seen = {
  roles: string[];
  systemCount: number;
  leadingIsSystem: boolean;
  prompt: string;
  tools: string[];
};

/** Plays `steps` (null = a tool call, string = final text) and records each call's transcript. */
const scripted = (steps: Array<string | null>) => {
  const seen: Seen[] = [];
  const streamFn: StreamFn = (_m, context) => {
    const msgs = context.messages;
    seen.push({
      roles: msgs.map((m) => m.role),
      systemCount: msgs.filter((m) => m.role === "system").length,
      leadingIsSystem: msgs[0]?.role === "system",
      prompt: getCurrentSystemPrompt(msgs),
      tools: getCurrentTools(msgs).map((t) => t.name),
    });
    const m = reply(steps[Math.min(seen.length - 1, steps.length - 1)]!);
    const s = createAssistantMessageEventStream();
    s.push({ type: "start", partial: m });
    s.push({ type: "done", reason: m.stopReason as "stop", message: m });
    s.end();
    return s;
  };
  return { seen, streamFn };
};

const spec = (over: Record<string, unknown> = {}) =>
  defineAgent({
    id: "sys-probe",
    systemPrompt: "SYSTEM-PROMPT-MARKER you are the probe",
    inputSchema: Type.Object({ q: Type.String() }),
    outputSchema: Type.Unknown(),
    model: "m",
    tools: ["read"],
    ...over,
  } as never);

const ctx = (): RunContext => ({
  runId: "sys-run",
  depth: 0,
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
});

const run = (
  streamFn: StreamFn,
  extra: Partial<Parameters<typeof runAgentEffect>[0]> = {},
  s = spec(),
): Promise<RunResult<never>> => {
  const { deps: extraDeps, ...rest } = extra;
  return Effect.runPromise(
    runAgentEffect({
      spec: s,
      input: { q: "x" },
      ctx: ctx(),
      emit: () => {},
      deps: {
        sandbox: createNoneSandbox(),
        preResolvedModels: new Map([["m", { model, apiKey: "k" }]]),
        streamFn,
        ...extraDeps,
      },
      ...rest,
    }) as never,
  ) as never;
};

describe("system prompt reaches the model", () => {
  test("the rendered prompt and tool declarations lead every call, once, across turns", async () => {
    const { seen, streamFn } = scripted([null, null, "done"]);
    const result = await run(streamFn);
    expect(result.status).toBe("success");
    expect(seen.length).toBe(3);
    for (const call of seen) {
      expect(call.leadingIsSystem).toBe(true);
      expect(call.systemCount).toBe(1);
      expect(call.prompt).toContain("SYSTEM-PROMPT-MARKER you are the probe");
      expect(call.tools).toContain("read");
    }
  });

  test("the continue path (resume) sends the prompt once, replacing a stale one", async () => {
    const { seen, streamFn } = scripted(["done"]);
    const storage = createMemoryStorage();
    const stale = {
      role: "system",
      content: "STALE PROMPT from an earlier invocation",
      timestamp: 0,
    };
    const cp: CheckpointRow = {
      runId: "sys-run",
      seq: 1,
      messages: [
        stale,
        { role: "user", content: "first", timestamp: 1 },
        reply("earlier answer"),
        { role: "user", content: "follow-up", timestamp: 2 },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
      toolCalls: [],
      retriesUsed: 0,
      ts: 0,
    };
    const result = await run(streamFn, { resumeFrom: cp, deps: { storage } as never });
    expect(result.status).toBe("success");
    expect(seen.length).toBe(1);
    expect(seen[0]!.systemCount).toBe(1);
    expect(seen[0]!.leadingIsSystem).toBe(true);
    expect(seen[0]!.prompt).toContain("SYSTEM-PROMPT-MARKER");
    expect(seen[0]!.prompt).not.toContain("STALE PROMPT");
  });

  test("a pre-migration checkpoint (no system message) resumes with the prompt exactly once", async () => {
    const { seen, streamFn } = scripted([null, "done"]);
    const storage = createMemoryStorage();
    // Hand-built 0.3.0-next.x shape: user / assistant / user, no system message.
    const cp: CheckpointRow = {
      runId: "sys-run",
      seq: 1,
      messages: [
        { role: "user", content: "first", timestamp: 1 },
        reply("earlier answer"),
        { role: "user", content: "follow-up", timestamp: 2 },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
      toolCalls: [],
      retriesUsed: 0,
      ts: 0,
    };
    const result = await run(streamFn, { resumeFrom: cp, deps: { storage } as never });
    expect(result.status).toBe("success");
    expect(seen.length).toBe(2);
    for (const call of seen) {
      expect(call.systemCount).toBe(1);
      expect(call.roles[0]).toBe("system");
      expect(call.prompt).toContain("SYSTEM-PROMPT-MARKER you are the probe");
    }
    // History is intact behind it.
    expect(seen[0]!.roles.slice(1)).toEqual(["user", "assistant", "user"]);
  });

  test("checkpoints never store the system message, so a resume of a resume stays at one", async () => {
    const { seen, streamFn } = scripted(["one"]);
    const storage = createMemoryStorage();
    const first = await run(streamFn, { deps: { storage } as never });
    expect(first.status).toBe("success");
    const cp = await Effect.runPromise(storage.loadLatestCheckpoint("sys-run"));
    const stored = cp!.messages as Array<{ role: string }>;
    expect(stored.some((m) => m.role === "system")).toBe(false);
    const again = scripted(["two"]);
    const next = await run(again.streamFn, {
      resumeFrom: {
        ...cp!,
        messages: [...stored, { role: "user", content: "more", timestamp: 9 }],
      },
      deps: { storage } as never,
    });
    expect(next.status).toBe("success");
    expect(again.seen[0]!.systemCount).toBe(1);
    expect(seen.length).toBe(1);
  });

  test("the postSuccess loop carries the prompt too", async () => {
    const { seen, streamFn } = scripted(["answer", "closing summary"]);
    const result = await run(
      streamFn,
      {},
      spec({ lifecycle: { postSuccess: [{ kind: "prompt", text: "now summarise" }] } }),
    );
    expect(result.status).toBe("success");
    expect(seen.length).toBe(2);
    for (const call of seen) {
      expect(call.systemCount).toBe(1);
      expect(call.prompt).toContain("SYSTEM-PROMPT-MARKER");
    }
    expect(seen[1]!.roles.at(-1)).toBe("user");
  });

  test("a pending or deferred stop reason fails the run with a clear message", async () => {
    for (const stop of ["pending", "deferred"] as const) {
      const streamFn: StreamFn = () => {
        const m = { ...reply("partial text"), stopReason: stop } as AssistantMessage;
        const s = createAssistantMessageEventStream();
        s.push({ type: "start", partial: m });
        s.push({ type: "done", reason: "stop", message: m });
        s.end();
        return s;
      };
      const result = await run(streamFn);
      expect(result.status).toBe("error");
      expect(result.error?.message).toContain(`${stop} response`);
      expect(result.error?.message).toContain("not supported");
    }
  });
});
