/** #81: a provider stream that never yields ends the call; the chain fails over on it. */
import { describe, expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@mariozechner/pi-ai";

import {
  createProviderChain,
  withStreamIdleTimeout,
  type ChainStreamFn,
  type ProviderFailoverNotice,
} from "../src/index.ts";

const model = (provider = "openrouter") =>
  ({
    id: "openai/gpt-5-mini",
    name: "x",
    api: "openai-completions",
    provider,
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }) as Model<"openai-completions">;
const ctx = { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as unknown as Context;
const answer = (provider: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: `from ${provider}` }],
  api: "openai-completions",
  provider,
  model: "m",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
});
const answering: ChainStreamFn = (m) => {
  const s = createAssistantMessageEventStream();
  const a = answer(m.provider);
  queueMicrotask(() => {
    s.push({ type: "start", partial: a });
    s.push({ type: "done", reason: "stop", message: a });
    s.end();
  });
  return s;
};
const silent: ChainStreamFn = () => createAssistantMessageEventStream();

describe("withStreamIdleTimeout", () => {
  test("a stream with no events ends with a timeout error, and the inner call is aborted", async () => {
    let signal: AbortSignal | undefined;
    const fn = withStreamIdleTimeout((_m, _c, o) => {
      signal = o?.signal;
      return createAssistantMessageEventStream();
    }, 30);
    const r = await (await fn(model(), ctx)).result();
    expect(r.stopReason).toBe("error");
    expect(r.errorMessage).toBe("Request timed out.");
    expect(signal?.aborted).toBe(true);
  });

  test("an open that never settles throws a timeout; a throw passes through unchanged", async () => {
    await expect(
      Promise.resolve(withStreamIdleTimeout(() => new Promise(() => {}), 30)(model(), ctx)),
    ).rejects.toThrow("Request timed out.");
    const err = Object.assign(new Error("403 nope"), { status: 403 });
    await expect(
      Promise.resolve(
        withStreamIdleTimeout(() => {
          throw err;
        }, 30)(model(), ctx),
      ),
    ).rejects.toBe(err);
  });

  test("a normal stream passes through; one that ends without a final event is a failure", async () => {
    const ok = await (await withStreamIdleTimeout(answering, 1_000)(model(), ctx)).result();
    expect(ok.stopReason).toBe("stop");
    const cut = await (
      await withStreamIdleTimeout(() => {
        const s = createAssistantMessageEventStream();
        queueMicrotask(() => s.end());
        return s;
      }, 1_000)(model(), ctx)
    ).result();
    expect(cut.stopReason).toBe("error");
  });

  test("0 turns it off (the function is returned as is)", () => {
    expect(withStreamIdleTimeout(answering, 0)).toBe(answering);
  });
});

describe("provider chain: an idle attempt fails over", () => {
  test("a provider that never yields is a timeout failure; the next provider answers", async () => {
    const notices: ProviderFailoverNotice[] = [];
    const entry = (name: string) => ({
      name,
      apiKey: "k",
      baseUrl: `https://${name}.test/v1`,
      models: { "openai/gpt-5-mini": { id: "m" } },
    });
    const chain = createProviderChain({
      providers: [entry("a"), entry("b")],
      streams: { a: silent, b: answering },
      streamIdleTimeoutMs: 30,
    });
    const r = await (await chain.forRun((n) => notices.push(n))(model("a"), ctx)).result();
    expect(r.stopReason).toBe("stop");
    expect(r.provider).toBe("b");
    expect(notices[0]).toMatchObject({ from: "a", to: "b", failureClass: "timeout" });
  });
});
