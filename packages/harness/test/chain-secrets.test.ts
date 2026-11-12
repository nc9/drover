/**
 * Credentials given to a chain entry as settings (#54) never leave towards anything but the
 * provider: not the result, events, errors, the chain record, storage or the trace. Over a real
 * HTTP transport whose error body and headers echo the key back, as some providers do.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import {
  TRACE_VERSION,
  defineAgent,
  traceToJsonl,
  type HarnessEvent,
  type RunContext,
} from "@droveragent/core";
import { createProviderChain } from "@droveragent/model";
import { createNoneSandbox } from "@droveragent/sandbox";
import { createMemoryStorage } from "@droveragent/storage";

import { runAgentEffect } from "../src/run.ts";

const KEY = "sk-SENTINEL-KEY-0123456789";
const HEADER = "Bearer SENTINEL-HEADER-0123456789";

const sse = (text: string) =>
  new Response(
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

describe("chain entry credentials never leak", () => {
  test("a sentinel key and auth header appear nowhere in result, events, storage, record or trace", async () => {
    const seenAuth: string[] = [];
    // First provider refuses and echoes the credentials back in its body and a header.
    const refuse = Bun.serve({
      port: 0,
      fetch: (req) => {
        seenAuth.push(req.headers.get("authorization") ?? "", req.headers.get("x-gw-auth") ?? "");
        return new Response(
          JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY} (${HEADER})` } }),
          {
            status: 401,
            headers: { "content-type": "application/json", "x-request-id": KEY },
          },
        );
      },
    });
    const answer = Bun.serve({ port: 0, fetch: () => sse("answered") });
    try {
      const model = (base: string) =>
        ({ id: "m-1", contextWindow: 100_000, maxTokens: 1_000, baseUrl: base }) as never;
      const providers = createProviderChain({
        providers: [
          {
            name: "openrouter",
            apiKey: KEY,
            baseUrl: `http://127.0.0.1:${refuse.port}/v1`,
            headers: { "x-gw-auth": HEADER },
            models: { "test/m": model(`http://127.0.0.1:${refuse.port}/v1`) },
            useEnv: false,
          },
          {
            name: "second",
            apiKey: "sk-other",
            baseUrl: `http://127.0.0.1:${answer.port}/v1`,
            models: { "test/m": model(`http://127.0.0.1:${answer.port}/v1`) },
            useEnv: false,
          },
        ],
        models: { main: "test/m" },
        includeProviderText: false,
      });
      const storage = createMemoryStorage();
      const events: HarnessEvent[] = [];
      const ctx: RunContext = {
        runId: "secret-run",
        depth: 0,
        cwd: process.cwd(),
        env: {},
        signal: new AbortController().signal,
      };
      const result = await Effect.runPromise(
        runAgentEffect({
          spec: defineAgent({
            id: "secret-probe",
            systemPrompt: "probe",
            inputSchema: Type.Object({ q: Type.String() }),
            outputSchema: Type.Unknown(),
            model: "main",
            tools: [],
          }),
          input: { q: "x" },
          ctx,
          emit: (e) => events.push(e),
          deps: { sandbox: createNoneSandbox(), providers, storage },
        }),
      );
      expect(result.status).toBe("success");
      expect(result.finalText).toBe("answered");
      // The credentials did reach the provider (they are not just dropped).
      expect(seenAuth).toEqual([`Bearer ${KEY}`, HEADER]);
      expect(result.chainRecord?.map((r) => [r.provider, r.failed, r.answered])).toEqual([
        ["openrouter", 1, 0],
        ["second", 0, 1],
      ]);
      const stored = await Effect.runPromise(
        Effect.all([
          storage.loadRun("secret-run"),
          storage.listEvents("secret-run"),
          storage.loadLatestCheckpoint("secret-run"),
        ]),
      );
      const trace = traceToJsonl({
        header: { traceVersion: TRACE_VERSION, runId: "secret-run" },
        events,
      });
      const everything = JSON.stringify([result, events, stored]) + trace;
      expect(everything).not.toContain("SENTINEL");
    } finally {
      refuse.stop(true);
      answer.stop(true);
    }
  });
});
