import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import { getModel } from "@earendil-works/pi-ai/compat";

import { DEFAULT_ALIASES, resolveModel } from "../src/index.ts";

describe("DEFAULT_ALIASES against the real pi-ai registry", () => {
  for (const [name, entry] of Object.entries(DEFAULT_ALIASES)) {
    test(`alias "${name}" resolves to a registry model`, async () => {
      const m = getModel(entry.provider as never, entry.modelId as never);
      expect(m).toBeDefined();
      expect((m as { id: string }).id).toBe(entry.modelId);
      const r = await Effect.runPromise(
        resolveModel(name, { runId: "r", env: { OPENROUTER_API_KEY: "k" } }),
      );
      expect(r.model.id).toBe(entry.modelId);
      expect(r.model.provider).toBe(entry.provider);
    });
  }
});
