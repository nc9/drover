/**
 * End to end: repeatRefusalPlugin in a run. A tool call that failed is not run again when
 * the model resends it; the refusal is marked `denied.code: "repeat_refusal"` on the
 * `tool_call_end` and counted by the trace summary; a cap refusal is not fingerprinted.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import {
  defineAgent,
  defineTool,
  summarizeTrace,
  type HarnessEvent,
  type HarnessPlugin,
  type RunContext,
} from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import type { PreResolvedModel } from "@droveragent/model";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";

// Relative imports: harness does not depend on plugins.
import { repeatRefusalPlugin } from "../../plugins/src/repeat-refusal.ts";
import { toolCallCapPlugin } from "../../plugins/src/tool-call-cap.ts";
import { runAgentEffect } from "../src/run.ts";

const MODEL_NAME = "rr-model";
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
} as unknown as PreResolvedModel["model"];

const msg = (over: Partial<AssistantMessage>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider: "openrouter",
  model: "custom/rr",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
  ...over,
});

/** The model sends `probe(args)` on each of the first `repeats` turns, then answers. */
const resending = (repeats: number, args: Record<string, unknown>): StreamFn => {
  let turn = 0;
  return () => {
    turn += 1;
    const s = createAssistantMessageEventStream();
    const m =
      turn <= repeats
        ? msg({
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: `c${turn}`, name: "probe", arguments: args }],
          })
        : msg({ content: [{ type: "text", text: "done" }] });
    s.push({ type: "start", partial: m });
    s.push({ type: "done", reason: m.stopReason as "stop", message: m });
    s.end();
    return s;
  };
};

const run = async (plugins: HarnessPlugin[], streamFn: StreamFn, fails = true) => {
  const state = { executed: 0 };
  const probe = defineTool({
    id: "probe",
    description: "probe",
    inputSchema: Type.Object({ target: Type.String() }),
    execute: () =>
      Effect.sync(() => {
        state.executed += 1;
        return fails
          ? { content: "refused: not allowed for this target", isError: true }
          : { content: "ok" };
      }),
  });
  const events: HarnessEvent[] = [];
  const ctx: RunContext = {
    runId: "rr-run",
    depth: 0,
    cwd: process.cwd(),
    env: {},
    signal: new AbortController().signal,
  };
  const result = await Effect.runPromise(
    runAgentEffect({
      spec: defineAgent({
        id: "rr-probe",
        systemPrompt: "probe",
        inputSchema: Type.Object({ q: Type.String() }),
        outputSchema: Type.Unknown(),
        model: MODEL_NAME,
        tools: [],
        plugins: [{ id: "probe-tools", tools: [probe] }, ...plugins],
      }),
      input: { q: "hi" },
      ctx,
      emit: (e) => events.push(e),
      deps: {
        sandbox: createNoneSandbox(),
        preResolvedModels: new Map([[MODEL_NAME, { model: fakeModel, apiKey: "sk-fake" }]]),
        streamFn,
      },
    }),
  );
  const ends = events.filter(
    (e): e is Extract<HarnessEvent, { kind: "tool_call_end" }> => e.kind === "tool_call_end",
  );
  return { result, events, ends, state };
};

describe("repeatRefusalPlugin in a run", () => {
  test("a refused call resent 3 times runs once; the repeats are answered and counted", async () => {
    const guard = repeatRefusalPlugin();
    const { result, ends, events, state } = await run([guard], resending(3, { target: "x" }));
    expect(result.status).toBe("success");
    expect(state.executed).toBe(1);
    expect(ends.map((e) => e.result.denied?.code ?? null)).toEqual([
      null,
      "repeat_refusal",
      "repeat_refusal",
    ]);
    expect(ends[1]!.result.content).toContain("This exact probe call already failed once");
    // The earlier tool text is not echoed back to the model.
    expect(ends[1]!.result.content).not.toContain("not allowed for this target");
    expect(guard.usage("rr-run")).toEqual({ failed: 1, repeated: 2 });
    const summary = summarizeTrace(events);
    expect(summary.toolCalls).toMatchObject({ count: 3, errors: 3, repeatedFailures: 2 });
  });

  test("a cap refusal is marked tool_call_cap and is never fingerprinted as the call's failure", async () => {
    const { ends, state } = await run(
      [toolCallCapPlugin({ perTool: { probe: 1 }, warnAt: false }), repeatRefusalPlugin()],
      resending(3, { target: "x" }),
      false, // the tool succeeds when it runs
    );
    expect(state.executed).toBe(1);
    expect(ends.map((e) => e.result.denied ?? null)).toEqual([
      null,
      { plugin: "tool-call-cap", code: "tool_call_cap" },
      { plugin: "tool-call-cap", code: "tool_call_cap" },
    ]);
  });

  test("edit, then rerun: a failing check, a successful destructive fix, the same check runs again", async () => {
    const state = { fixed: false, checks: 0 };
    const check = defineTool({
      id: "check",
      description: "run the tests",
      inputSchema: Type.Object({ suite: Type.String() }),
      execute: () =>
        Effect.sync(() => {
          state.checks += 1;
          return state.fixed ? { content: "pass" } : { content: "1 failing", isError: true };
        }),
    });
    const fix = defineTool({
      id: "fix",
      description: "edit the code",
      inputSchema: Type.Object({ path: Type.String() }),
      destructive: true,
      execute: () =>
        Effect.sync(() => {
          state.fixed = true;
          return { content: "edited" };
        }),
    });
    const script = (withFix: boolean): StreamFn => {
      const calls: Array<[string, Record<string, unknown>]> = withFix
        ? [
            ["check", { suite: "all" }],
            ["check", { suite: "all" }], // no change in between: refused
            ["fix", { path: "a.ts" }],
            ["check", { suite: "all" }], // after the fix: runs again
          ]
        : [
            ["check", { suite: "all" }],
            ["check", { suite: "all" }],
          ];
      let turn = 0;
      return () => {
        turn += 1;
        const s = createAssistantMessageEventStream();
        const next = calls[turn - 1];
        const m = next
          ? msg({
              stopReason: "toolUse",
              content: [{ type: "toolCall", id: `c${turn}`, name: next[0], arguments: next[1] }],
            })
          : msg({ content: [{ type: "text", text: "done" }] });
        s.push({ type: "start", partial: m });
        s.push({ type: "done", reason: m.stopReason as "stop", message: m });
        s.end();
        return s;
      };
    };
    const runIt = async (withFix: boolean) => {
      state.fixed = false;
      state.checks = 0;
      const events: HarnessEvent[] = [];
      const result = await Effect.runPromise(
        runAgentEffect({
          spec: defineAgent({
            id: "rr-fix",
            systemPrompt: "probe",
            inputSchema: Type.Object({ q: Type.String() }),
            outputSchema: Type.Unknown(),
            model: MODEL_NAME,
            tools: [],
            plugins: [{ id: "fix-tools", tools: [check, fix] }, repeatRefusalPlugin()],
          }),
          input: { q: "hi" },
          ctx: {
            runId: withFix ? "rr-fix-1" : "rr-fix-2",
            depth: 0,
            cwd: process.cwd(),
            env: {},
            signal: new AbortController().signal,
          },
          emit: (e) => events.push(e),
          deps: {
            sandbox: createNoneSandbox(),
            preResolvedModels: new Map([[MODEL_NAME, { model: fakeModel, apiKey: "sk-fake" }]]),
            streamFn: script(withFix),
          },
        }),
      );
      const codes = events
        .filter(
          (e): e is Extract<HarnessEvent, { kind: "tool_call_end" }> => e.kind === "tool_call_end",
        )
        .map(
          (e) => `${e.toolName}:${e.result.denied?.code ?? (e.result.isError ? "error" : "ok")}`,
        );
      return { result, codes, checks: state.checks };
    };

    const fixed = await runIt(true);
    expect(fixed.result.status).toBe("success");
    expect(fixed.codes).toEqual(["check:error", "check:repeat_refusal", "fix:ok", "check:ok"]);
    expect(fixed.checks).toBe(2);

    const unfixed = await runIt(false);
    expect(unfixed.codes).toEqual(["check:error", "check:repeat_refusal"]);
    expect(unfixed.checks).toBe(1);
  });

  test('a coerced argument ("1" validated to 1) still matches the failed call through the real harness', async () => {
    const seenInputs: unknown[] = [];
    let executed = 0;
    const page = defineTool({
      id: "page",
      description: "fetch a page by number",
      // A plain JSON Schema (no TypeBox metadata, like an MCP tool's): pi coerces "1" to 1 for
      // these before validating, so the call's raw and validated arguments differ.
      inputSchema: {
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
      } as unknown as ReturnType<typeof Type.Object>,
      execute: (input) =>
        Effect.sync(() => {
          executed += 1;
          seenInputs.push(input);
          return { content: "no such page", isError: true };
        }),
    });
    const args: Array<Record<string, unknown>> = [{ n: "1" }, { n: "1" }, { n: 1 }];
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      const s = createAssistantMessageEventStream();
      const a = args[turn - 1];
      const m = a
        ? msg({
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: `c${turn}`, name: "page", arguments: a }],
          })
        : msg({ content: [{ type: "text", text: "done" }] });
      s.push({ type: "start", partial: m });
      s.push({ type: "done", reason: m.stopReason as "stop", message: m });
      s.end();
      return s;
    };
    const events: HarnessEvent[] = [];
    const guard = repeatRefusalPlugin();
    const result = await Effect.runPromise(
      runAgentEffect({
        spec: defineAgent({
          id: "rr-coerce",
          systemPrompt: "probe",
          inputSchema: Type.Object({ q: Type.String() }),
          outputSchema: Type.Unknown(),
          model: MODEL_NAME,
          tools: [],
          plugins: [{ id: "page-tools", tools: [page] }, guard],
        }),
        input: { q: "hi" },
        ctx: {
          runId: "rr-coerce",
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
        },
      }),
    );
    expect(result.status).toBe("success");
    // the tool saw the validated value once; both resends (raw and already-numeric) were refused
    expect(executed).toBe(1);
    expect(seenInputs).toEqual([{ n: 1 }]);
    const codes = events
      .filter(
        (e): e is Extract<HarnessEvent, { kind: "tool_call_end" }> => e.kind === "tool_call_end",
      )
      .map((e) => e.result.denied?.code ?? null);
    expect(codes).toEqual([null, "repeat_refusal", "repeat_refusal"]);
    expect(guard.inFlight("rr-coerce")).toBe(0);
  });
});
