/**
 * Provider failover inside a real agent run, over HTTP: two local servers
 * stand in for OpenRouter and the Cloudflare AI Gateway, and the run goes
 * through pi-ai's real OpenAI client (so the status codes and error text the
 * classifier reads are the ones production sees).
 */
import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { defineAgent, type HarnessEvent } from "@droveragent/core";
import { createNoneSandbox } from "@droveragent/sandbox";

import { createProviderChain, runAgent } from "../src/index.ts";

const spec = defineAgent({
  id: "provider-chain-probe",
  systemPrompt: "probe",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Unknown(),
  model: "gpt-mini",
  tools: ["read"],
});

const chunk = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usageChunk = (prompt: number, completion: number) =>
  `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } })}\n\n`;
const sse = (...parts: string[]) =>
  new Response([...parts, "data: [DONE]\n\n"].join(""), {
    headers: { "content-type": "text/event-stream" },
  });

const toolCallTurn = (path: string) =>
  sse(
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path }) },
        },
      ],
    }),
    chunk({}, "tool_calls"),
    usageChunk(100, 10),
  );
const textTurn = (text: string) =>
  sse(chunk({ role: "assistant", content: text }), chunk({}, "stop"), usageChunk(200, 20));
const error = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Seen {
  url: string;
  headers: Headers;
  body: {
    model: string;
    messages: Array<{ role: string; content?: unknown; tool_calls?: unknown }>;
  };
}

function server(respond: (n: number, seen: Seen) => Response) {
  const seen: Seen[] = [];
  const s = Bun.serve({
    port: 0,
    async fetch(req) {
      const entry: Seen = {
        url: new URL(req.url).pathname,
        headers: req.headers,
        body: (await req.json()) as Seen["body"],
      };
      seen.push(entry);
      return respond(seen.length, entry);
    },
  });
  return { seen, base: `http://127.0.0.1:${s.port}`, stop: () => s.stop(true) };
}

/** pi-ai's own provider entries, pointed at the local servers (extraModels stand in for the registry). */
function chainFor(a: { base: string }, b: { base: string }) {
  const model = (provider: string, id: string, baseUrl: string) =>
    ({
      id,
      name: id,
      api: "openai-completions",
      provider,
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    }) as never;
  return createProviderChain({
    providers: ["openrouter", "cloudflare-ai-gateway"],
    extraModels: [
      model("openrouter", "openai/gpt-5-mini", `${a.base}/api/v1`),
      model(
        "cloudflare-ai-gateway",
        "gpt-5-mini",
        `${b.base}/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai`,
      ),
    ],
    apiKeys: { openrouter: "or-key", "cloudflare-ai-gateway": "cf-token" },
    env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_GATEWAY_ID: "gw" },
    models: { "gpt-mini": "openai/gpt-5-mini" },
  });
}

async function collect(handle: ReturnType<typeof runAgent>) {
  const events: HarnessEvent[] = [];
  const drain = (async () => {
    for await (const e of handle.events) events.push(e);
  })();
  const result = await handle.result;
  await drain;
  return { result, events };
}

describe("provider chain inside a run", () => {
  test("the first call fails over: the run completes on the second provider", async () => {
    const a = server(() =>
      error(402, { error: { message: "This request requires more credits", code: 402 } }),
    );
    const b = server(() => textTurn("hello from the gateway"));
    try {
      const { result, events } = await collect(
        runAgent(
          spec,
          { q: "x" },
          { providers: chainFor(a, b), sandbox: createNoneSandbox(), env: {} },
        ),
      );
      expect(result.status).toBe("success");
      expect(result.finalText).toBe("hello from the gateway");

      // What each provider was sent.
      expect(a.seen[0]!.url).toBe("/api/v1/chat/completions");
      expect(a.seen[0]!.body.model).toBe("openai/gpt-5-mini");
      expect(a.seen[0]!.headers.get("authorization")).toBe("Bearer or-key");
      expect(b.seen[0]!.url).toBe("/v1/acct/gw/openai/chat/completions");
      expect(b.seen[0]!.body.model).toBe("gpt-5-mini");
      expect(b.seen[0]!.headers.get("cf-aig-authorization")).toBe("Bearer cf-token");

      const fo = events.filter((e) => e.kind === "provider_failover");
      expect(fo).toHaveLength(1);
      expect(fo[0]).toMatchObject({
        action: "failover",
        from: "openrouter",
        to: "cloudflare-ai-gateway",
        failureClass: "credits_exhausted",
        status: 402,
      });
      // Usage is attributed to the provider that served it.
      expect(Object.keys(result.usageByProvider ?? {})).toEqual(["cloudflare-ai-gateway"]);
      const usage = events.find((e) => e.kind === "usage");
      expect(usage).toMatchObject({ provider: "cloudflare-ai-gateway" });
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  test("mid-run, after a tool call: the conversation and tool results carry over", async () => {
    const a = server((n) =>
      n === 1
        ? toolCallTurn(import.meta.path)
        : error(403, {
            error: {
              message: "Country, region, or territory not supported",
              code: "unsupported_country_region_territory",
            },
          }),
    );
    const b = server(() => textTurn("done on the gateway"));
    try {
      const { result, events } = await collect(
        runAgent(
          spec,
          { q: "x" },
          { providers: chainFor(a, b), sandbox: createNoneSandbox(), env: {} },
        ),
      );
      expect(result.status).toBe("success");
      expect(result.finalText).toBe("done on the gateway");
      expect(result.toolCalls).toEqual(["read"]);

      // The gateway saw the whole conversation: user turn, assistant tool call, tool result.
      const roles = b.seen[0]!.body.messages.map((m) => m.role);
      expect(roles).toEqual(["system", "user", "assistant", "tool"]);
      const toolMsg = b.seen[0]!.body.messages[3]!;
      expect(JSON.stringify(toolMsg.content)).toContain("provider chain inside a run");

      const fo = events.find((e) => e.kind === "provider_failover");
      // pi-ai flattens the error to text and drops the body's code, so over this transport a
      // 403 is a key refusal; a transport that keeps the code gets "region_refused".
      expect(fo).toMatchObject({ failureClass: "key_refused", status: 403 });
      // Not retried in place.
      expect(a.seen).toHaveLength(2);

      // Cost and tokens per provider: turn 1 on openrouter, turn 2 on the gateway.
      expect(result.usageByProvider?.openrouter?.inputTokens).toBe(100);
      expect(result.usageByProvider?.["cloudflare-ai-gateway"]?.inputTokens).toBe(200);
      expect(result.usage.inputTokens).toBe(300);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  test("both providers failing: the trace says so, and nothing was billed", async () => {
    const a = server(() => error(402, { error: { message: "no credits" } }));
    const b = server(() => error(401, { error: { message: "bad token" } }));
    try {
      const { result, events } = await collect(
        runAgent(
          spec,
          { q: "x" },
          { providers: chainFor(a, b), sandbox: createNoneSandbox(), env: {} },
        ),
      );
      // Both failures are in the trace. Turning the chain's final error message
      // into a failed run is the harness's job (provider errors fail the run).
      expect(result.usageByProvider).toBeUndefined();
      expect(
        events
          .filter((e) => e.kind === "provider_failover")
          .map((e) => (e as { action: string }).action),
      ).toEqual(["failover", "exhausted"]);
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});
