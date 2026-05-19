import { describe, test, expect } from "bun:test";
import { Effect } from "effect";

import { memoryRateLimitPlugin } from "../src/rate-limit.ts";

const runCtx = {
  runId: "r",
  depth: 0,
  cwd: "/",
  env: {} as Record<string, string>,
  signal: new AbortController().signal,
};

describe("memoryRateLimitPlugin", () => {
  test("allows first remember, denies the second in same turn", async () => {
    const p = memoryRateLimitPlugin({ writesPerTurn: 1 });
    const first = await Effect.runPromise(p.beforeToolCall!("remember", {}, runCtx));
    const second = await Effect.runPromise(p.beforeToolCall!("remember", {}, runCtx));
    expect(first.kind).toBe("allow");
    expect(second.kind).toBe("deny");
  });

  test("does not gate other tools", async () => {
    const p = memoryRateLimitPlugin({ writesPerTurn: 1 });
    const r1 = await Effect.runPromise(p.beforeToolCall!("recall", {}, runCtx));
    const r2 = await Effect.runPromise(p.beforeToolCall!("recall", {}, runCtx));
    expect(r1.kind).toBe("allow");
    expect(r2.kind).toBe("allow");
  });

  test("counter resets on turn_start", async () => {
    const p = memoryRateLimitPlugin({ writesPerTurn: 1 });
    await Effect.runPromise(p.beforeToolCall!("remember", {}, runCtx));
    await Effect.runPromise(
      p.onEvent!({ kind: "turn_start", runId: "r", turn: 2, ts: Date.now() }, runCtx),
    );
    const after = await Effect.runPromise(p.beforeToolCall!("remember", {}, runCtx));
    expect(after.kind).toBe("allow");
  });

  test("higher cap allows multiple writes per turn", async () => {
    const p = memoryRateLimitPlugin({ writesPerTurn: 3 });
    for (let i = 0; i < 3; i++) {
      const r = await Effect.runPromise(p.beforeToolCall!("remember", {}, runCtx));
      expect(r.kind).toBe("allow");
    }
    const fourth = await Effect.runPromise(p.beforeToolCall!("remember", {}, runCtx));
    expect(fourth.kind).toBe("deny");
  });
});
