import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { Effect } from "effect";
import { defineAgent } from "@droveragent/core";

import { createDisabledSandbox, runAgent, type PreResolvedModel } from "../src/core.ts";

const bundleInputs = async (entry: string): Promise<string[]> => {
  const r = await Bun.build({
    entrypoints: [new URL(entry, import.meta.url).pathname],
    target: "browser",
    external: ["node:*", "@opentelemetry/api"],
    metafile: true,
  });
  expect(r.success).toBe(true);
  return Object.keys(
    (r as unknown as { metafile: { inputs: Record<string, unknown> } }).metafile.inputs,
  );
};

describe("@droveragent/facade/core", () => {
  test("bundles for the browser target without just-bash (the default entry does not)", async () => {
    const core = await bundleInputs("../src/core.ts");
    expect(core.some((f) => f.includes("just-bash"))).toBe(false);
    // Control: the default entry is the one that imports it.
    const indexSrc = await Bun.file(new URL("../src/index.ts", import.meta.url).pathname).text();
    expect(indexSrc).toContain("@droveragent/sandbox-just-bash");
    const coreSrc = await Bun.file(new URL("../src/core.ts", import.meta.url).pathname).text();
    expect(coreSrc).not.toContain("sandbox-just-bash");
  });

  test('sandbox "none": runs, tools that need the filesystem fail softly', async () => {
    const spec = defineAgent({
      id: "core-none",
      systemPrompt: "probe",
      inputSchema: Type.Object({ q: Type.String() }),
      outputSchema: Type.Unknown(),
      model: "m",
      tools: ["read"],
    });
    const sse = (d: unknown, finish: string | null): string =>
      `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "x", choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
    let n = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          n++ === 0
            ? sse(
                {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "c",
                      type: "function",
                      function: { name: "read", arguments: '{"path":"/etc/hosts"}' },
                    },
                  ],
                },
                null,
              ) +
                sse({}, "tool_calls") +
                "data: [DONE]\n\n"
            : sse({ role: "assistant", content: "done" }, null) +
                sse({}, "stop") +
                "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    try {
      const models = new Map<string, PreResolvedModel>([
        [
          "m",
          {
            model: {
              id: "x",
              name: "x",
              api: "openai-completions",
              provider: "openrouter",
              baseUrl: `http://127.0.0.1:${server.port}/v1`,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1e5,
              maxTokens: 4096,
            } as unknown as PreResolvedModel["model"],
            apiKey: "k",
          },
        ],
      ]);
      const h = runAgent(spec, { q: "x" }, { models, sandbox: "none" });
      const r = await h.result;
      expect(r.status).toBe("success");
      expect(r.finalText).toBe("done");
      expect(r.toolCalls).toEqual(["read"]);
    } finally {
      await server.stop(true);
    }
  });

  test("disabled sandbox denies every op and advertises no shell", async () => {
    const s = createDisabledSandbox();
    expect(s.capabilities.shell).toBe(false);
    for (const eff of [
      s.readFile("/a"),
      s.writeFile("/a", "x"),
      s.run("ls", []),
      s.assertPathAllowed("/a"),
    ]) {
      const r = await Effect.runPromise(Effect.either(eff as Effect.Effect<unknown, unknown>));
      expect(r._tag).toBe("Left");
    }
    expect(s.resolvePath("a/b", "/w/")).toBe("/w/a/b");
    expect(s.resolvePath("/a", "/w")).toBe("/a");
  });
});
