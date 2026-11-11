import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type HarnessEvent, type RunContext } from "@droveragent/core";
import { runAgentEffect, type HarnessDeps } from "@droveragent/harness";
import { createNoneSandbox } from "@droveragent/sandbox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

import {
  ReplayDriftError,
  ReplayExhaustedError,
  createRecorder,
  recordStream,
  replayStream,
  type StreamRecording,
} from "../src/index.ts";

const MODEL = "rr-model";

const makeSpec = (systemPrompt: string) =>
  defineAgent({
    id: "rr-probe",
    systemPrompt,
    inputSchema: Type.Object({ q: Type.String() }),
    outputSchema: Type.Unknown(),
    model: MODEL,
    tools: ["read"],
  });

const fakeModel = {
  id: "custom/rr",
  name: "RR",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as never;

const usage = (n: number) => ({
  input: n,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: n + 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
});

const base = (content: AssistantMessage["content"], stopReason: "stop" | "toolUse", n: number) =>
  ({
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openrouter",
    model: "custom/rr",
    usage: usage(n),
    stopReason,
    timestamp: Date.now(),
  }) satisfies AssistantMessage;

/** The "real provider": turn 0 asks for a tool, turn 1 answers. Counts calls. */
const makeFake = (): { fn: StreamFn; calls: () => number } => {
  let n = 0;
  const fn: StreamFn = () => {
    const turn = n++;
    const s = createAssistantMessageEventStream();
    const empty = base([], "stop", 0);
    s.push({ type: "start", partial: empty });
    if (turn === 0) {
      const call = { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } } as const;
      const msg = base([call], "toolUse", 10);
      s.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: msg });
      s.push({ type: "done", reason: "toolUse", message: msg });
    } else {
      const msg = base([{ type: "text", text: "the answer" }], "stop", 20);
      s.push({ type: "text_delta", contentIndex: 0, delta: "the answer", partial: msg });
      s.push({ type: "done", reason: "stop", message: msg });
    }
    s.end();
    return s;
  };
  return { fn, calls: () => n };
};

const run = async (systemPrompt: string, streamFn: StreamFn) => {
  const events: HarnessEvent[] = [];
  const ctx: RunContext = {
    runId: "rr-run",
    depth: 0,
    cwd: process.cwd(),
    env: {},
    signal: new AbortController().signal,
  };
  const deps: HarnessDeps = {
    sandbox: createNoneSandbox(),
    preResolvedModels: new Map([[MODEL, { model: fakeModel, apiKey: "sk-fake" }]]),
    streamFn,
  };
  const result = await Effect.runPromise(
    Effect.either(
      runAgentEffect({
        spec: makeSpec(systemPrompt),
        input: { q: "hi" },
        ctx,
        emit: (e) => events.push(e),
        deps,
      }),
    ),
  );
  return { events, result };
};

/** Events without wall-clock fields, so two runs compare equal. */
const stable = (events: HarnessEvent[]): unknown =>
  JSON.parse(JSON.stringify(events, (k, v) => (k === "ts" || k === "timestamp" ? undefined : v)));

const record = async (): Promise<{
  recording: StreamRecording;
  first: Awaited<ReturnType<typeof run>>;
}> => {
  const rec = createRecorder();
  const fake = makeFake();
  const first = await run("sys", recordStream(fake.fn, rec.sink));
  return { recording: rec.recording(), first };
};

describe("record / replay", () => {
  test("records one turn per model call, JSON-serialisable", async () => {
    const { recording, first } = await record();
    expect(first.result._tag).toBe("Right");
    expect(recording.turns.map((t) => t.index)).toEqual([0, 1]);
    expect(recording.turns[0]!.events.at(-1)!.type).toBe("done");
    const roundTripped = JSON.parse(JSON.stringify(recording)) as StreamRecording;
    expect(roundTripped).toEqual(recording);
  });

  test("replay (via JSON, no network, real provider never called) yields identical events and output", async () => {
    const { recording, first } = await record();
    const loaded = JSON.parse(JSON.stringify(recording)) as StreamRecording;
    const replayed = await run("sys", replayStream(loaded));
    expect(replayed.result._tag).toBe("Right");
    const a = (
      first.result as { right: { finalText: string; usage: unknown; toolCalls: string[] } }
    ).right;
    const b = (replayed.result as { right: typeof a }).right;
    expect(b.finalText).toBe("the answer");
    expect(b.finalText).toBe(a.finalText);
    expect(b.usage).toEqual(a.usage);
    expect(b.toolCalls).toEqual(a.toolCalls);
    expect(stable(replayed.events)).toEqual(stable(first.events));
  });

  test("replaying twice from one recording gives the same result (recording not mutated)", async () => {
    const { recording } = await record();
    const snapshot = JSON.stringify(recording);
    const r1 = await run("sys", replayStream(recording));
    const r2 = await run("sys", replayStream(recording));
    expect(stable(r1.events)).toEqual(stable(r2.events));
    expect(JSON.stringify(recording)).toBe(snapshot);
  });

  test("drift: a changed system prompt fails the replayed run loudly", async () => {
    const { recording } = await record();
    const r = await run("a DIFFERENT prompt", replayStream(recording));
    const msg = JSON.stringify(r.result);
    expect(msg).toContain("replay drift at turn 0");
  });

  test("drift: onDrift callback and 'ignore' let replay proceed", async () => {
    const { recording } = await record();
    const seen: ReplayDriftError[] = [];
    const r = await run("changed", replayStream(recording, { onDrift: (e) => seen.push(e) }));
    expect(r.result._tag).toBe("Right");
    expect(seen.length).toBe(2);
    expect(seen[0]).toBeInstanceOf(ReplayDriftError);
    const r2 = await run("changed", replayStream(recording, { onDrift: "ignore" }));
    expect(r2.result._tag).toBe("Right");
  });

  test("exhausted: more calls than recorded throws ReplayExhaustedError", () => {
    const { fn } = { fn: replayStream({ version: 1, turns: [] }) };
    expect(() => fn(fakeModel, { messages: [] })).toThrow(ReplayExhaustedError);
  });

  test("a real stream that throws is recorded as an error turn and replays as one", async () => {
    const rec = createRecorder();
    const boom: StreamFn = () => {
      throw new Error("provider down");
    };
    const wrapped = recordStream(boom, rec.sink);
    const s = await wrapped(fakeModel, { messages: [] });
    const result = await s.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("provider down");
    const replayed = await replayStream(rec.recording(), { onDrift: "ignore" })(fakeModel, {
      messages: [],
    });
    expect((await replayed.result()).errorMessage).toBe("provider down");
  });
});
