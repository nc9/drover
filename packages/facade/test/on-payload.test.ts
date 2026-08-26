/**
 * `RunOptions.onPayload` end-to-end: facade option → HarnessDeps → loopConfig →
 * pi → the bytes on the wire.
 *
 * The value of asserting on the real request body (rather than on the hook
 * object) is that the hook is only useful if its return value is what the
 * provider actually receives — `undefined` means "unchanged" in pi's contract,
 * so a hook wired to the wrong seam fails silently and looks like a no-op.
 * A local SSE stub stands in for OpenRouter.
 */
import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { defineAgent } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";

import { runAgent, type PreResolvedModel } from "../src/index.ts";

const MODEL_NAME = "routing-probe-model";

const spec = defineAgent({
  id: "facade-on-payload-probe",
  systemPrompt: "probe",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Unknown(),
  model: MODEL_NAME,
  tools: [],
});

const SSE_BODY = [
  `data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"custom/routing-probe","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}`,
  ``,
  `data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"custom/routing-probe","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
  ``,
  `data: [DONE]`,
  ``,
  ``,
].join("\n");

describe("facade RunOptions.onPayload", () => {
  test("the patched body is what the provider receives", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push((await req.json()) as Record<string, unknown>);
        return new Response(SSE_BODY, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    try {
      const models = new Map<string, PreResolvedModel>([
        [
          MODEL_NAME,
          {
            model: {
              id: "custom/routing-probe",
              name: "Routing Probe",
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

      const handle = runAgent(
        spec,
        { q: "x" },
        {
          models,
          sandbox: createNoneSandbox(),
          env: {},
          onPayload: (payload) => ({
            ...(payload as Record<string, unknown>),
            provider: { order: ["amazon-bedrock/us-east-1"], allow_fallbacks: true },
          }),
        },
      );
      const result = await handle.result;
      expect(result.status).toBe("success");

      expect(bodies.length).toBeGreaterThan(0);
      const body = bodies[0]!;
      expect(body.provider).toEqual({
        order: ["amazon-bedrock/us-east-1"],
        allow_fallbacks: true,
      });
      // Everything drover built is still there — the hook patches, not replaces.
      expect(body.model).toBe("custom/routing-probe");
      expect(Array.isArray(body.messages)).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});
