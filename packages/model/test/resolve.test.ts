import { describe, test, expect } from "bun:test";
import { Effect } from "effect";

import { resolveModel, type PreResolvedModel } from "../src/index.ts";

describe("resolveModel — preResolved", () => {
  // The pre-resolved path never inspects the model object, so a stub is fine.
  const fakeModel = { id: "custom/model", provider: "custom" } as never;

  test("returns the injected model, skipping alias/env lookup", async () => {
    const preResolved = new Map<string, PreResolvedModel>([
      ["job-x", { model: fakeModel, apiKey: "sk-test" }],
    ]);
    const r = await Effect.runPromise(resolveModel("job-x", { runId: "r", preResolved, env: {} }));
    expect(r.model).toBe(fakeModel);
    expect(r.apiKey).toBe("sk-test");
  });

  test("applies the :reasoning suffix on top of an injected model", async () => {
    const preResolved = new Map<string, PreResolvedModel>([
      ["job-x", { model: fakeModel, apiKey: "sk" }],
    ]);
    const r = await Effect.runPromise(
      resolveModel("job-x:high", { runId: "r", preResolved, env: {} }),
    );
    expect(r.reasoning).toBe("high");
  });

  test("falls through to normal resolution when the name is not pre-resolved", async () => {
    const exit = await Effect.runPromiseExit(
      resolveModel("totally-unknown-model-xyz", {
        runId: "r",
        preResolved: new Map(),
        env: {},
      }),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("resolveModel — unknown models fail fast with ModelError", () => {
  test("bare unknown name -> ModelError routing_miss", async () => {
    const either = await Effect.runPromise(
      Effect.either(resolveModel("no-such-model-anywhere", { runId: "r", env: {} })),
    );
    expect(either._tag).toBe("Left");
    if (either._tag === "Left") {
      expect(either.left._tag).toBe("ModelError");
      expect(either.left.reason).toBe("routing_miss");
      expect(either.left.modelName).toBe("no-such-model-anywhere");
    }
  });

  test("well-formed provider slug for a model missing from pi-ai's table -> ModelError, not undefined", async () => {
    // pi-ai's getModel is a bare Map.get: it returns undefined on a miss
    // instead of throwing. The resolver must convert that into a typed
    // failure BEFORE the loop starts — never a ResolvedModel with
    // model === undefined.
    const either = await Effect.runPromise(
      Effect.either(
        resolveModel("openrouter:openai/gpt-99-does-not-exist", {
          runId: "r",
          env: { OPENROUTER_API_KEY: "sk-test" },
        }),
      ),
    );
    expect(either._tag).toBe("Left");
    if (either._tag === "Left") {
      expect(either.left._tag).toBe("ModelError");
      expect(either.left.reason).toBe("routing_miss");
      expect(either.left.message).toContain("openai/gpt-99-does-not-exist");
    }
  });

  test("known provider slug still resolves to a defined model", async () => {
    const r = await Effect.runPromise(
      resolveModel("openrouter:openai/gpt-5.5", {
        runId: "r",
        env: { OPENROUTER_API_KEY: "sk-test" },
      }),
    );
    expect(r.model).toBeDefined();
    expect(r.model.id).toBe("openai/gpt-5.5");
    expect(r.apiKey).toBe("sk-test");
  });
});
