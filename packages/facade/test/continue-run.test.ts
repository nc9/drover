/**
 * `resumeAgent(..., { appendMessages })` — continue a FINISHED run with new
 * user input. A scripted SSE server stands in for the provider and records
 * every request body, so assertions are on what the model actually saw.
 */
import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { Effect } from "effect";
import { defineAgent } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";
import { createMemoryStorage } from "@droveragent/storage/memory";

import { resumeAgent, runAgent, type PreResolvedModel } from "../src/index.ts";

const MODEL_NAME = "continue-probe-model";

const spec = defineAgent({
  id: "continue-probe",
  systemPrompt: "probe",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Unknown(),
  model: MODEL_NAME,
  tools: ["read"],
});

const chunk = (delta: unknown, finish: string | null, usage?: unknown): string =>
  `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 1,
    model: "custom/continue-probe",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;

const usageOf = (p: number, c: number) => ({
  prompt_tokens: p,
  completion_tokens: c,
  total_tokens: p + c,
});

const textReply = (text: string, p: number, c: number): string =>
  chunk({ role: "assistant", content: text }, null) +
  chunk({}, "stop", usageOf(p, c)) +
  "data: [DONE]\n\n";

const toolReply = (p: number, c: number): string =>
  chunk(
    {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: "/nope.txt" }) },
        },
      ],
    },
    null,
  ) +
  chunk({}, "tool_calls", usageOf(p, c)) +
  "data: [DONE]\n\n";

const withServer = async (
  replies: string[],
  fn: (ctx: {
    models: Map<string, PreResolvedModel>;
    bodies: Array<{ messages: Array<{ role: string; content: unknown }> }>;
  }) => Promise<void>,
): Promise<void> => {
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push((await req.json()) as (typeof bodies)[number]);
      const body = replies[Math.min(bodies.length - 1, replies.length - 1)]!;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const models = new Map<string, PreResolvedModel>([
      [
        MODEL_NAME,
        {
          model: {
            id: "custom/continue-probe",
            name: "Continue Probe",
            api: "openai-completions",
            provider: "openrouter",
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8_192,
          } as unknown as PreResolvedModel["model"],
          apiKey: "sk-fake",
        },
      ],
    ]);
    await fn({ models, bodies });
  } finally {
    await server.stop(true);
  }
};

describe("resumeAgent appendMessages (continue a finished run)", () => {
  test("final checkpoint holds the complete history, incl. last assistant + tool results", async () => {
    await withServer([toolReply(10, 5), textReply("first answer", 20, 7)], async ({ models }) => {
      const storage = createMemoryStorage();
      const r = await runAgent(
        spec,
        { q: "one" },
        { models, sandbox: createNoneSandbox(), env: {}, storage },
      ).result;
      expect(r.status).toBe("success");
      const cp = await Effect.runPromise(storage.loadLatestCheckpoint(r.runId));
      const roles = (cp!.messages as Array<{ role: string }>).map((m) => m.role);
      expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
    });
  });

  test("continues a success run: model sees prior history + new user message; usageDelta is per-call", async () => {
    await withServer(
      [toolReply(10, 5), textReply("first answer", 20, 7), textReply("second answer", 40, 9)],
      async ({ models, bodies }) => {
        const storage = createMemoryStorage();
        const opts = { models, sandbox: createNoneSandbox(), env: {}, storage };
        const first = await runAgent(spec, { q: "one" }, opts).result;
        expect(first.status).toBe("success");
        expect(first.usageDelta).toEqual(first.usage);

        const cont = await resumeAgent(spec, first.runId, {
          ...opts,
          appendMessages: ["and now a follow-up"],
        }).result;
        expect(cont.status).toBe("success");
        expect(cont.finalText).toBe("second answer");
        expect(cont.runId).toBe(first.runId);

        // The third request carried everything, ending with the new user turn.
        const sent = bodies[2]!.messages;
        expect(sent.map((m) => m.role)).toEqual([
          "system",
          "user",
          "assistant",
          "tool",
          "assistant",
          "user",
        ]);
        expect(JSON.stringify(sent.at(-1))).toContain("and now a follow-up");

        // Cumulative vs this-call usage.
        expect(cont.usageDelta).toEqual({ inputTokens: 40, outputTokens: 9 });
        expect(cont.usage.inputTokens).toBe(first.usage.inputTokens + 40);
        expect(cont.usage.outputTokens).toBe(first.usage.outputTokens + 9);

        // And it can be continued again (the new final checkpoint is complete).
        const again = await resumeAgent(spec, first.runId, {
          ...opts,
          appendMessages: ["third"],
        }).result;
        expect(again.status).toBe("success");
        expect(bodies[3]!.messages.at(-1)).toMatchObject({ role: "user" });
        expect(bodies[3]!.messages.length).toBe(sent.length + 2);
      },
    );
  });

  test("a continuation's own budget: tokens counted for this call only", async () => {
    await withServer(
      [textReply("first answer", 500, 100), textReply("second answer", 40, 9)],
      async ({ models }) => {
        const storage = createMemoryStorage();
        const opts = { models, sandbox: createNoneSandbox(), env: {}, storage };
        const first = await runAgent(spec, { q: "one" }, opts).result;
        expect(first.usage.inputTokens).toBe(500);
        // 600 tokens already spent by the run; this continuation may spend 100.
        const ok = await resumeAgent(spec, first.runId, {
          ...opts,
          appendMessages: ["next"],
          budget: { maxTokens: 100 },
        }).result;
        expect(ok.status).toBe("success");
        const over = await resumeAgent(spec, first.runId, {
          ...opts,
          appendMessages: ["again"],
          budget: { maxTokens: 40 },
        }).result;
        expect(over.status).toBe("quota");
        expect(over.error?.message).toBe(
          "invocation tokens budget exceeded (limit 40, observed 49)",
        );
      },
    );
  });

  test("a continuation of a run already past the wrap-up threshold: notice on its first call, never in the checkpoint (#62)", async () => {
    const wrapSpec = defineAgent({
      ...spec,
      id: "continue-wrap-probe",
      quota: { maxTokens: 1000, wrapUp: { at: 0.5 } },
    });
    await withServer(
      [textReply("first answer", 500, 100), textReply("second answer", 10, 5)],
      async ({ models, bodies }) => {
        const storage = createMemoryStorage();
        const opts = { models, sandbox: createNoneSandbox(), env: {}, storage };
        const first = await runAgent(wrapSpec, { q: "one" }, opts).result;
        expect(first.status).toBe("success");
        // 600 of 1000 spent: past the 0.5 threshold, but the first run made no later call.
        expect(JSON.stringify(bodies[0]!.messages)).not.toContain("Budget notice");

        const cont = await resumeAgent(wrapSpec, first.runId, {
          ...opts,
          appendMessages: ["and now a follow-up"],
        }).result;
        expect(cont.status).toBe("success");
        expect(cont.wrapUp).toMatchObject({ dimension: "tokens", outcome: "wrapped_up" });
        // The continuation's first (and only) call carries the notice.
        expect(bodies.length).toBe(2);
        expect(JSON.stringify(bodies[1]!.messages)).toContain("Budget notice");

        const cp = await Effect.runPromise(storage.loadLatestCheckpoint(first.runId));
        const stored = JSON.stringify(cp!.messages);
        expect(stored).toContain("and now a follow-up");
        expect(stored).toContain("second answer");
        expect(stored).not.toContain("Budget notice");
      },
    );
  });

  test("an invocation budget breach on a validated answer is forgiven only once the spec's wrap-up fired (#62)", async () => {
    const wrapSpec = defineAgent({
      ...spec,
      id: "continue-wrap-budget-probe",
      quota: { maxTokens: 1000, wrapUp: { at: 0.5 } },
    });
    await withServer(
      [textReply("first answer", 500, 100), textReply("second answer", 10, 5)],
      async ({ models }) => {
        const storage = createMemoryStorage();
        const opts = { models, sandbox: createNoneSandbox(), env: {}, storage };
        const first = await runAgent(wrapSpec, { q: "one" }, opts).result;
        const cont = await resumeAgent(wrapSpec, first.runId, {
          ...opts,
          appendMessages: ["next"],
          budget: { maxTokens: 10 },
        }).result;
        expect(cont.status).toBe("success");
        expect(cont.wrapUp?.overshoot).toEqual({
          dimension: "tokens",
          limit: 10,
          observed: 15,
          scope: "budget",
        });
      },
    );
  });

  test("the same invocation budget breach without the spec's wrapUp ends quota (#62)", async () => {
    await withServer(
      [textReply("first answer", 500, 100), textReply("second answer", 10, 5)],
      async ({ models }) => {
        const storage = createMemoryStorage();
        const opts = { models, sandbox: createNoneSandbox(), env: {}, storage };
        const first = await runAgent(spec, { q: "one" }, opts).result;
        const cont = await resumeAgent(spec, first.runId, {
          ...opts,
          appendMessages: ["next"],
          budget: { maxTokens: 10 },
        }).result;
        expect(cont.status).toBe("quota");
        expect(cont.error?.message).toBe(
          "invocation tokens budget exceeded (limit 10, observed 15)",
        );
        expect(cont.wrapUp).toBeUndefined();
      },
    );
  });

  test("an invocation turn cap reached on the answer turn is not a breach (#62)", async () => {
    await withServer(
      [textReply("first answer", 5, 5), textReply("second answer", 5, 5)],
      async ({ models }) => {
        const storage = createMemoryStorage();
        const opts = { models, sandbox: createNoneSandbox(), env: {}, storage };
        const first = await runAgent(spec, { q: "one" }, opts).result;
        const cont = await resumeAgent(spec, first.runId, {
          ...opts,
          appendMessages: ["next"],
          budget: { maxTurns: 1 },
        }).result;
        expect(cont.status).toBe("success");
        expect(cont.finalText).toBe("second answer");
        expect(cont.wrapUp).toBeUndefined();
      },
    );
  });

  test("finished run without appendMessages still refuses, pointing at the option", async () => {
    await withServer([textReply("hi", 1, 1)], async ({ models }) => {
      const storage = createMemoryStorage();
      const opts = { models, sandbox: createNoneSandbox(), env: {}, storage };
      const first = await runAgent(spec, { q: "one" }, opts).result;
      const r = await resumeAgent(spec, first.runId, opts).result;
      expect(r.error?.tag).toBe("ResumeError");
      expect(r.error?.message).toContain("appendMessages");
    });
  });

  test("spec drift is still rejected on continuation", async () => {
    await withServer([textReply("hi", 1, 1)], async ({ models }) => {
      const storage = createMemoryStorage();
      const opts = { models, sandbox: createNoneSandbox(), env: {}, storage };
      const first = await runAgent(spec, { q: "one" }, opts).result;
      const drifted = { ...spec, systemPrompt: "changed" };
      const r = await resumeAgent(drifted, first.runId, { ...opts, appendMessages: ["x"] }).result;
      expect(r.error?.tag).toBe("ResumeError");
      expect(r.error?.message).toContain("spec drift");
    });
  });

  test("empty appendMessages and error-status runs are refused", async () => {
    await withServer([textReply("hi", 1, 1)], async ({ models }) => {
      const storage = createMemoryStorage();
      const opts = { models, sandbox: createNoneSandbox(), env: {}, storage };
      const first = await runAgent(spec, { q: "one" }, opts).result;
      const empty = await resumeAgent(spec, first.runId, { ...opts, appendMessages: [] }).result;
      expect(empty.error?.message).toContain("at least one");
      await Effect.runPromise(storage.updateRun(first.runId, { status: "error" }));
      const bad = await resumeAgent(spec, first.runId, { ...opts, appendMessages: ["x"] }).result;
      expect(bad.error?.message).toContain("not paused or success");
    });
  });

  test("a run that is already running is refused (no concurrent continuation)", async () => {
    await withServer([textReply("hi", 1, 1)], async ({ models }) => {
      const storage = createMemoryStorage();
      const opts = { models, sandbox: createNoneSandbox(), env: {}, storage };
      const first = await runAgent(spec, { q: "one" }, opts).result;
      await Effect.runPromise(storage.updateRun(first.runId, { status: "running" }));
      const r = await resumeAgent(spec, first.runId, { ...opts, appendMessages: ["x"] }).result;
      expect(r.error?.tag).toBe("ResumeError");
      expect(r.error?.message).toContain("is marked running");
      expect(r.error?.message).toContain("crashed");
    });
  });

  test("a paused run can be continued with appendMessages too", async () => {
    await withServer(
      [textReply("first answer", 10, 2), textReply("after pause", 10, 2)],
      async ({ models, bodies }) => {
        const storage = createMemoryStorage();
        const opts = { models, sandbox: createNoneSandbox(), env: {}, storage };
        const first = await runAgent(spec, { q: "one" }, opts).result;
        await Effect.runPromise(storage.updateRun(first.runId, { status: "paused" }));
        const r = await resumeAgent(spec, first.runId, {
          ...opts,
          appendMessages: ["extra context"],
        }).result;
        expect(r.status).toBe("success");
        expect(r.finalText).toBe("after pause");
        expect(JSON.stringify(bodies[1]!.messages.at(-1))).toContain("extra context");
      },
    );
  });

  test("appendMessages entries must be strings (runtime guard)", async () => {
    await withServer([textReply("hi", 1, 1)], async ({ models }) => {
      const storage = createMemoryStorage();
      const opts = { models, sandbox: createNoneSandbox(), env: {}, storage };
      const first = await runAgent(spec, { q: "one" }, opts).result;
      const r = await resumeAgent(spec, first.runId, {
        ...opts,
        appendMessages: [{ role: "system", content: "x" }] as unknown as string[],
      }).result;
      expect(r.error?.tag).toBe("ResumeError");
      expect(r.error?.message).toContain("must be strings or");
    });
  });

  test("postSuccess + continuation: the continuation sees the post-processing turn too", async () => {
    const withPost = defineAgent({
      ...spec,
      lifecycle: { postSuccess: [{ kind: "prompt", text: "POST-STEP: tidy up" }] },
    });
    await withServer(
      [textReply("first answer", 10, 2), textReply("tidied", 10, 2), textReply("second", 10, 2)],
      async ({ models, bodies }) => {
        const storage = createMemoryStorage();
        const opts = { models, sandbox: createNoneSandbox(), env: {}, storage };
        const first = await runAgent(withPost, { q: "one" }, opts).result;
        expect(first.status).toBe("success");
        const cont = await resumeAgent(withPost, first.runId, {
          ...opts,
          appendMessages: ["next question"],
        }).result;
        expect(cont.status).toBe("success");
        // Request 3 (the continuation's first) carries the post step and its reply, then the new turn.
        const sent = JSON.stringify(bodies[2]!.messages);
        expect(sent).toContain("POST-STEP: tidy up");
        expect(sent).toContain("tidied");
        expect(JSON.stringify(bodies[2]!.messages.at(-1))).toContain("next question");
      },
    );
  });
});
