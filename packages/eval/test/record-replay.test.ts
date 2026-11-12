import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineAgent, type HarnessEvent, type RunContext } from "@droveragent/core";
import { runAgentEffect, type HarnessDeps } from "@droveragent/harness";
import { createNoneSandbox } from "@droveragent/sandbox";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  normalizeContext,
  type AssistantMessage,
} from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import {
  ReplayAmbiguousError,
  ReplayDriftError,
  RECORDING_VERSION,
  ReplayExhaustedError,
  createRecorder,
  hashRequest,
  recordStream,
  replayStream,
  threadKey,
  type RecordedTurn,
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
  JSON.parse(
    JSON.stringify(events, (k, v) =>
      k === "ts" || k === "timestamp" || k === "durationMs" ? undefined : v,
    ),
  );

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
    expect(msg).toContain("replay drift at call 0 of thread");
    expect(msg).toContain("no recorded conversation starts with this system prompt");
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
    const { fn } = { fn: replayStream({ version: RECORDING_VERSION, turns: [] }) };
    expect(() => fn(fakeModel, normalizeContext(normalizeContext({ messages: [] })))).toThrow(
      ReplayExhaustedError,
    );
  });

  test("an old (version 1) recording is rejected with a re-record error", () => {
    expect(() => replayStream({ version: 1 as never, turns: [] })).toThrow(/re-record/);
  });

  test("the request key reads the transcript's system message: prompt and tool names", () => {
    const user = { role: "user" as const, content: "q", timestamp: 1 };
    const tool = (name: string) => ({ name, description: "d", parameters: { type: "object" } });
    const base = normalizeContext({ systemPrompt: "one", messages: [user], tools: [tool("a")] });
    const same = normalizeContext({ systemPrompt: "one", messages: [user], tools: [tool("a")] });
    const otherPrompt = normalizeContext({
      systemPrompt: "two",
      messages: [user],
      tools: [tool("a")],
    });
    const otherTools = normalizeContext({
      systemPrompt: "one",
      messages: [user],
      tools: [tool("a"), tool("b")],
    });
    expect(hashRequest(base)).toBe(hashRequest(same));
    expect(hashRequest(base)).not.toBe(hashRequest(otherPrompt));
    expect(hashRequest(base)).not.toBe(hashRequest(otherTools));
    expect(threadKey(base)).not.toBe(threadKey(otherPrompt));
    expect(threadKey(base)).toBe(threadKey(otherTools)); // tools are not part of the thread
  });

  test("wall-clock durationMs (pi 1.x) does not change the request key", () => {
    const call = (ms: number) =>
      normalizeContext({
        systemPrompt: "s",
        messages: [
          { role: "user" as const, content: "q", timestamp: 1 },
          {
            role: "toolResult" as const,
            toolCallId: "c",
            toolName: "read",
            content: [{ type: "text" as const, text: "x" }],
            isError: false,
            timestamp: 2,
            durationMs: ms,
          },
        ],
      });
    expect(hashRequest(call(3))).toBe(hashRequest(call(900)));
  });

  test("a real stream that throws is recorded as an error turn and replays as one", async () => {
    const rec = createRecorder();
    const boom: StreamFn = () => {
      throw new Error("provider down");
    };
    const wrapped = recordStream(boom, rec.sink);
    const s = await wrapped(fakeModel, normalizeContext({ messages: [] }));
    const result = await s.result();
    expect(result.stopReason).toBe("error");
    // The live run sees the real error; the recording keeps only its status-only form.
    expect(result.errorMessage).toBe("provider down");
    const replayed = await replayStream(rec.recording())(
      fakeModel,
      normalizeContext({ messages: [] }),
    );
    expect((await replayed.result()).errorMessage).toBe("provider error");
    const kept = createRecorder();
    const s2 = await recordStream(boom, kept.sink, { keepProviderText: true })(
      fakeModel,
      normalizeContext({ messages: [] }),
    );
    await s2.result();
    expect(JSON.stringify(kept.recording())).toContain("provider down");
  });

  test("redact hook scrubs the stored turn but not what the live run sees", async () => {
    const rec = createRecorder();
    const fake = makeFake();
    const scrub = (v: unknown): unknown =>
      JSON.parse(JSON.stringify(v).replaceAll("the answer", "[redacted]"));
    const first = await run(
      "sys",
      recordStream(fake.fn, rec.sink, { redact: (t) => scrub(t) as typeof t }),
    );
    // Live run saw the real text.
    expect((first.result as { right: { finalText: string } }).right.finalText).toBe("the answer");
    // The stored recording does not contain it.
    const stored = JSON.stringify(rec.recording());
    expect(stored).not.toContain("the answer");
    expect(stored).toContain("[redacted]");
    // Replaying it yields the redacted text.
    const replayed = await run("sys", replayStream(rec.recording()));
    expect((replayed.result as { right: { finalText: string } }).right.finalText).toBe(
      "[redacted]",
    );
  });

  test("parallel subagents: calls keyed by thread replay correctly in any interleaving", async () => {
    // Two conversations (two subagents), two calls each; the reply names the thread and call.
    const ctxFor = (who: string, turn: number) =>
      normalizeContext({
        systemPrompt: `agent ${who}`,
        messages: [
          { role: "user" as const, content: `task for ${who}`, timestamp: 1 },
          ...(turn > 0
            ? [{ role: "user" as const, content: `follow-up ${turn}`, timestamp: 2 }]
            : []),
        ],
      });
    const real: StreamFn = (_m, context) => {
      const s = createAssistantMessageEventStream();
      const who = getCurrentSystemPrompt(context.messages);
      const msg = base(
        [
          {
            type: "text",
            text: `${who} #${context.messages.filter((m) => m.role !== "system").length}`,
          },
        ],
        "stop",
        1,
      );
      s.push({ type: "done", reason: "stop", message: msg });
      s.end();
      return s;
    };
    const rec = createRecorder();
    const recFn = recordStream(real, rec.sink);
    // Recorded order: A0, B0, A1, B1.
    for (const [who, turn] of [
      ["A", 0],
      ["B", 0],
      ["A", 1],
      ["B", 1],
    ] as const)
      await (await recFn(fakeModel, ctxFor(who, turn))).result();
    const recording = JSON.parse(JSON.stringify(rec.recording())) as StreamRecording;
    expect(new Set(recording.turns.map((t) => t.thread)).size).toBe(2);
    // Replayed in a different interleaving: B0, B1, A0, A1.
    const replay = replayStream(recording);
    const texts: string[] = [];
    for (const [who, turn] of [
      ["B", 0],
      ["B", 1],
      ["A", 0],
      ["A", 1],
    ] as const) {
      const m = await (await replay(fakeModel, ctxFor(who, turn))).result();
      texts.push((m.content[0] as { text: string }).text);
    }
    expect(texts).toEqual(["agent B #1", "agent B #2", "agent A #1", "agent A #2"]);
  });

  test("drift names the first differing call of its thread", async () => {
    const { recording } = await record();
    // Same system prompt and first message, but a changed tool result in call 1.
    const replay = replayStream(recording);
    const r = await run("sys", (model, context, options) => {
      const ctx =
        context.messages.length > 1
          ? {
              ...context,
              messages: context.messages.map((m) =>
                m.role === "toolResult"
                  ? { ...m, content: [{ type: "text" as const, text: "a different file" }] }
                  : m,
              ),
            }
          : context;
      return replay(model, ctx, options);
    });
    const msg = JSON.stringify(r.result);
    expect(msg).toMatch(/replay drift at call 1 of thread [0-9a-f]+ \(recorded turn 1\)/);
  });

  test("a recording holds no API key, request headers or raw provider text", async () => {
    const rec = createRecorder();
    const failing: StreamFn = () => {
      const s = createAssistantMessageEventStream();
      s.push({
        type: "error",
        reason: "error",
        error: {
          ...base([], "stop", 0),
          stopReason: "error",
          errorMessage: "402 the prompt said: SECRET-PAGE-TEXT",
        },
      });
      s.end();
      return s;
    };
    const fn = recordStream(failing, rec.sink);
    await (
      await fn(fakeModel, normalizeContext({ messages: [] }), {
        apiKey: "sk-or-SECRET-KEY",
        headers: { authorization: "Bearer SECRET-BEARER" },
      })
    ).result();
    const json = JSON.stringify(rec.recording());
    expect(json).not.toContain("SECRET");
    expect(json).toContain("provider error 402");
  });

  test("replay is deterministic: tool-call ids, content and order are the recorded ones", async () => {
    const { recording } = await record();
    const r1 = await run("sys", replayStream(recording));
    const r2 = await run("sys", replayStream(recording));
    const ids = (events: HarnessEvent[]) =>
      events
        .filter((e) => e.kind === "tool_call_start")
        .map((e) => (e as { toolUseId: string }).toolUseId);
    expect(ids(r1.events)).toEqual(["c1"]);
    expect(ids(r2.events)).toEqual(ids(r1.events));
    expect(stable(r1.events)).toEqual(stable(r2.events));
  });

  test("a throwing or rejecting sink, or a throwing redact, never hangs or fails the run", async () => {
    const throwing = recordStream(makeFake().fn, () => {
      throw new Error("disk full");
    });
    const r1 = await run("sys", throwing);
    expect(r1.result._tag).toBe("Right");
    expect((r1.result as { right: { finalText: string } }).right.finalText).toBe("the answer");
    expect(throwing.errors.map((e) => e.index)).toEqual([0, 1]);
    expect(String((throwing.errors[0]!.error as Error).message)).toBe("disk full");

    const seen: number[] = [];
    const rejecting = recordStream(makeFake().fn, async () => Promise.reject(new Error("net")), {
      onError: (e) => seen.push(e.index),
    });
    expect((await run("sys", rejecting)).result._tag).toBe("Right");
    expect(seen).toEqual([0, 1]);
    expect(rejecting.errors).toHaveLength(0); // handed to onError instead

    const badRedact = recordStream(makeFake().fn, () => {}, {
      redact: () => {
        throw new Error("redact bug");
      },
    });
    expect((await run("sys", badRedact)).result._tag).toBe("Right");
    expect(badRedact.errors).toHaveLength(2);
  }, 5_000);

  test("concurrent runs with an identical prompt and first message: ambiguous replay is refused with the cause", async () => {
    // Two calls on the same thread in flight at once, same request, different answers.
    let n = 0;
    const slow: StreamFn = () => {
      const k = n++;
      const s = createAssistantMessageEventStream();
      setTimeout(() => {
        const msg = base([{ type: "text", text: `answer ${k}` }], "stop", 1);
        s.push({ type: "done", reason: "stop", message: msg });
        s.end();
      }, 10);
      return s;
    };
    const rec = createRecorder();
    const fn = recordStream(slow, rec.sink);
    const same = normalizeContext({
      systemPrompt: "child",
      messages: [{ role: "user" as const, content: "task", timestamp: 1 }],
    });
    await Promise.all([
      (async () => (await fn(fakeModel, same)).result())(),
      (async () => (await fn(fakeModel, same)).result())(),
    ]);
    const recording = rec.recording();
    expect(recording.turns.some((t) => t.concurrent)).toBe(true);
    expect(() => replayStream(recording)(fakeModel, same)).toThrow(ReplayAmbiguousError);
    expect(() => replayStream(recording)(fakeModel, same)).toThrow(
      /identical system prompt and first message/,
    );
  });

  test("a sequential repeat of the same request (a retry) is not ambiguous: served in recorded order", async () => {
    let n = 0;
    const retrying: StreamFn = () => {
      const k = n++;
      const s = createAssistantMessageEventStream();
      s.push(
        k === 0
          ? {
              type: "error",
              reason: "error",
              error: { ...base([], "stop", 0), stopReason: "error", errorMessage: "429 slow down" },
            }
          : {
              type: "done",
              reason: "stop",
              message: base([{ type: "text", text: "ok" }], "stop", 1),
            },
      );
      s.end();
      return s;
    };
    const rec = createRecorder();
    const fn = recordStream(retrying, rec.sink);
    const ctxSame = normalizeContext({
      systemPrompt: "s",
      messages: [{ role: "user" as const, content: "q", timestamp: 1 }],
    });
    await (await fn(fakeModel, ctxSame)).result();
    await (await fn(fakeModel, ctxSame)).result();
    const replay = replayStream(rec.recording());
    expect((await (await replay(fakeModel, ctxSame)).result()).stopReason).toBe("error");
    expect((await (await replay(fakeModel, ctxSame)).result()).stopReason).toBe("stop");
  });

  describe("ambiguity check details", () => {
    const ctxOf = (second?: string) =>
      normalizeContext({
        systemPrompt: "child",
        messages: [
          { role: "user" as const, content: "task", timestamp: 1 },
          ...(second ? [{ role: "user" as const, content: second, timestamp: 2 }] : []),
        ],
      });
    const turn = (
      index: number,
      threadIndex: number,
      ctxArg: ReturnType<typeof ctxOf>,
      text: string,
      extra: Partial<RecordedTurn> = {},
      responseId = "r",
      timestamp = 0,
    ): RecordedTurn => ({
      index,
      thread: threadKey(ctxArg),
      threadIndex,
      requestHash: hashRequest(ctxArg),
      modelId: "m",
      events: [
        {
          type: "done",
          reason: "stop",
          message: {
            ...base([{ type: "text", text }], "stop", 1),
            timestamp,
            responseId,
          } as AssistantMessage,
        },
      ],
      ...extra,
    });

    test("concurrent answers that differ only in timestamp or responseId are not ambiguous", async () => {
      const c = ctxOf();
      const recording: StreamRecording = {
        version: RECORDING_VERSION,
        turns: [
          turn(0, 0, c, "same", { concurrent: true }, "gen-1", 100),
          turn(1, 1, c, "same", { concurrent: true }, "gen-2", 200),
        ],
      };
      const replay = replayStream(recording);
      const m = await (await replay(fakeModel, c)).result();
      expect((m.content[0] as { text: string }).text).toBe("same");
    });

    test("only the matching turns' concurrency counts: a sequential retry in a thread that also had concurrent calls replays", async () => {
      const first = ctxOf();
      const later = ctxOf("follow-up");
      const recording: StreamRecording = {
        version: RECORDING_VERSION,
        turns: [
          // Two concurrent calls with the same answer earlier in the thread.
          turn(0, 0, first, "same", { concurrent: true }),
          turn(1, 1, first, "same", { concurrent: true }),
          // Later, one request repeated sequentially (a retry) with different answers.
          turn(2, 2, later, "first try"),
          turn(3, 3, later, "second try"),
        ],
      };
      const replay = replayStream(recording);
      await (await replay(fakeModel, first)).result();
      await (await replay(fakeModel, first)).result();
      const a = await (await replay(fakeModel, later)).result();
      const b = await (await replay(fakeModel, later)).result();
      expect([a, b].map((m) => (m.content[0] as { text: string }).text)).toEqual([
        "first try",
        "second try",
      ]);
    });

    test("a call whose request cannot be hashed leaves no phantom in-flight call behind", async () => {
      const rec = createRecorder();
      let n = 0;
      const fast: StreamFn = () => {
        const s = createAssistantMessageEventStream();
        s.push({
          type: "done",
          reason: "stop",
          message: base([{ type: "text", text: `a${n++}` }], "stop", 1),
        });
        s.end();
        return s;
      };
      const fn = recordStream(fast, rec.sink);
      // A BigInt in the history makes the request hash throw (the thread key only reads the first message).
      const unhashable = normalizeContext({
        systemPrompt: "child",
        messages: [
          { role: "user" as const, content: "task", timestamp: 1 },
          { role: "user" as const, content: "x", timestamp: 2, extra: 1n } as never,
        ],
      });
      expect(() => fn(fakeModel, unhashable as never)).toThrow();
      await (await fn(fakeModel, ctxOf())).result();
      expect(rec.recording().turns.every((t) => !t.concurrent)).toBe(true);
    });
  });
});
