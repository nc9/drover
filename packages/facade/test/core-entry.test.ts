import { describe, expect, test } from "bun:test";
import { builtinModules, isBuiltin } from "node:module";
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

  test('sandbox "disabled": runs, tools that need the filesystem fail softly', async () => {
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
      const h = runAgent(spec, { q: "x" }, { models, sandbox: "disabled" });
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

/**
 * Workers guard for the `core` entry. Workers (with the `nodejs_compat` flag) provide
 * `node:path` and `node:crypto` at module load. Any other Node built-in, under its `node:`
 * name or its bare name (`fs`), must only be reached through a dynamic `import()`, so it is
 * loaded only by a feature a Worker does not use (the file loaders). A `require()` is not
 * lazy as far as the bundle can tell (it may sit at module scope), so it fails the guard
 * unless its exact site is allowlisted below after reading it.
 *
 * Note: `src/core.ts` imports the workspace packages through their built `dist/`, so this test
 * checks the built code: build first (`bun scripts/ci.ts build`; CI builds before testing).
 */
const WORKERS_STATIC_NODE = new Set(["path", "crypto"]);
/**
 * `require()` sites read and found to run inside a function, never at module load:
 * pi-ai's credentials-file lookup (`env-api-keys.js`) requires `node:fs` only when asked
 * for Google application-default credentials.
 */
const ALLOWED_REQUIRE_SITES: ReadonlyArray<{ file: RegExp; module: string }> = [
  { file: /@mariozechner\/pi-ai\/dist\/env-api-keys\.js$/, module: "fs" },
];
/** Minified browser bundle of `src/core.ts`, all pi-ai providers included. Measured: ~2.09 MB. */
const CORE_BUNDLE_BUDGET_BYTES = 2_400_000;

type MetaInputs = Record<string, { imports?: Array<{ path: string; kind: string }> }>;

/** `node:fs/promises` and `fs/promises` -> `fs`; anything not a Node built-in -> undefined. */
const builtinRoot = (spec: string): string | undefined => {
  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  if (!isBuiltin(bare)) return undefined;
  return bare.split("/")[0];
};

/** Node built-ins the bundle reaches outside a dynamic import, minus the Workers-provided ones and the allowlisted require sites. */
const nodeImportViolations = (inputs: MetaInputs): string[] =>
  Object.entries(inputs).flatMap(([file, info]) =>
    (info.imports ?? []).flatMap((imp) => {
      const root = builtinRoot(imp.path);
      if (root === undefined || imp.kind === "dynamic-import") return [];
      if (imp.kind === "import-statement" && WORKERS_STATIC_NODE.has(root)) return [];
      if (
        imp.kind === "require-call" &&
        ALLOWED_REQUIRE_SITES.some((s) => s.file.test(file) && s.module === root)
      ) {
        return [];
      }
      return [`${imp.path} (${imp.kind}) <- ${file}`];
    }),
  );

describe("Workers guard classifier", () => {
  test("bare builtin names count, and only a dynamic import is lazy", () => {
    expect(
      nodeImportViolations({
        "pkg/a.js": {
          imports: [
            { path: "node:path", kind: "import-statement" },
            { path: "crypto", kind: "import-statement" },
            { path: "node:fs/promises", kind: "dynamic-import" },
            { path: "effect", kind: "import-statement" },
          ],
        },
      }),
    ).toEqual([]);
    expect(
      nodeImportViolations({
        "pkg/b.js": {
          imports: [
            { path: "fs", kind: "import-statement" },
            { path: "fs/promises", kind: "import-statement" },
            { path: "node:child_process", kind: "import-statement" },
          ],
        },
      }),
    ).toEqual([
      "fs (import-statement) <- pkg/b.js",
      "fs/promises (import-statement) <- pkg/b.js",
      "node:child_process (import-statement) <- pkg/b.js",
    ]);
  });

  test("a require of a builtin fails unless its exact site is allowlisted", () => {
    expect(
      nodeImportViolations({
        "nm/some-lib/index.js": { imports: [{ path: "fs", kind: "require-call" }] },
        "nm/@mariozechner/pi-ai/dist/env-api-keys.js": {
          imports: [
            { path: "node:fs", kind: "require-call" },
            { path: "node:child_process", kind: "require-call" },
          ],
        },
      }),
    ).toEqual([
      "fs (require-call) <- nm/some-lib/index.js",
      "node:child_process (require-call) <- nm/@mariozechner/pi-ai/dist/env-api-keys.js",
    ]);
  });
});

describe("@droveragent/facade/core: Workers bundle guard", () => {
  test("static node:* imports are only those Workers provide; the rest are lazy", async () => {
    const r = await Bun.build({
      entrypoints: [new URL("../src/core.ts", import.meta.url).pathname],
      target: "browser",
      // Bare builtin names stay imports too (not browser stubs), so the guard sees them.
      external: ["node:*", ...builtinModules, "@opentelemetry/api"],
      metafile: true,
      minify: true,
    });
    expect(r.success).toBe(true);
    const inputs = (r as unknown as { metafile: { inputs: MetaInputs } }).metafile.inputs;
    expect(nodeImportViolations(inputs)).toEqual([]);
    const lazyNode = new Set(
      Object.values(inputs).flatMap((info) =>
        (info.imports ?? []).filter((i) => i.kind === "dynamic-import").map((i) => i.path),
      ),
    );
    // The file loaders still exist, lazily: this is what keeps them out of the static graph.
    expect(lazyNode.has("node:fs/promises")).toBe(true);
    const bytes = r.outputs.reduce((n, o) => n + o.size, 0);
    expect(bytes).toBeLessThan(CORE_BUNDLE_BUDGET_BYTES);
  });
});

test("the default entry re-exports createDisabledSandbox", async () => {
  const main = await import("../src/index.ts");
  expect(typeof main.createDisabledSandbox).toBe("function");
});
