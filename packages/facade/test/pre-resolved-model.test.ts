import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { defineAgent } from "@droveragent/core";

import { runAgent, type PreResolvedModel } from "../src/index.ts";

// A model name no alias map, provider slug, or pi-ai builtin knows —
// resolution can ONLY succeed through the injected pre-resolved map.
const MODEL_NAME = "energy-agent-model";

const spec = defineAgent({
  id: "pre-resolved-probe",
  systemPrompt: "probe",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Unknown(),
  model: MODEL_NAME,
  tools: [],
  quota: { maxTurns: 1 },
});

// Fully-formed pi-ai Model shape. baseUrl points at a closed local port so
// any accidental network attempt fails fast instead of hitting a provider.
const fakeModel = {
  id: "custom/energy-agent",
  name: "Energy Agent Custom",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as unknown as PreResolvedModel["model"];

const abortedSignal = (): AbortSignal => {
  const ac = new AbortController();
  ac.abort();
  return ac.signal;
};

describe("facade pre-resolved models", () => {
  test("without injection an unknown model fails resolution with ModelError", async () => {
    const handle = runAgent(spec, { q: "x" }, { signal: abortedSignal() });
    const result = await handle.result;
    expect(result.status).toBe("error");
    expect(result.error?.tag).toBe("ModelError");
  });

  test("options.models forwards to the harness and reaches the loop", async () => {
    const models = new Map<string, PreResolvedModel>([
      [MODEL_NAME, { model: fakeModel, apiKey: "sk-injected" }],
    ]);
    const handle = runAgent(spec, { q: "x" }, { models, signal: abortedSignal() });
    const result = await handle.result;
    // Resolution succeeded (no ModelError) — the run made it into pi's loop
    // and terminated on the pre-aborted signal instead.
    expect(result.error?.tag).not.toBe("ModelError");
    expect(result.status).toBe("cancelled");
  });
});
