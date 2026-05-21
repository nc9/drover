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
    const r = await Effect.runPromise(
      resolveModel("job-x", { runId: "r", preResolved, env: {} }),
    );
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
