import { describe, test, expect } from "bun:test";
import { Effect } from "effect";

import { createInMemoryMemory } from "../src/memory.ts";

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, never, never>);

describe("createInMemoryMemory", () => {
  test("put + get round-trip", async () => {
    const mem = createInMemoryMemory();
    const entry = await run(
      mem.put({
        scope: "global",
        kind: "user",
        summary: "User prefers concise commits",
        body: "Lowercase first word, ≤72 chars.",
      }),
    );
    expect(entry.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(entry.createdAt).toBeGreaterThan(0);
    expect(entry.updatedAt).toBeUndefined();
    const got = await run(mem.get(entry.id));
    expect(got?.summary).toBe("User prefers concise commits");
  });

  test("put with existing id updates updatedAt", async () => {
    const mem = createInMemoryMemory();
    const first = await run(
      mem.put({ scope: "global", kind: "user", summary: "v1", body: "body v1" }),
    );
    // Wait 5ms so timestamps differ deterministically
    await new Promise((r) => setTimeout(r, 5));
    const second = await run(
      mem.put({ id: first.id, scope: "global", kind: "user", summary: "v2", body: "body v2" }),
    );
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThan(first.createdAt);
    expect(second.summary).toBe("v2");
  });

  test("rejects agent scope without agentId", async () => {
    const mem = createInMemoryMemory();
    await expect(
      run(mem.put({ scope: "agent", kind: "user", summary: "x", body: "y" })),
    ).rejects.toBeDefined();
  });

  test("rejects run scope without runId", async () => {
    const mem = createInMemoryMemory();
    await expect(
      run(
        mem.put({
          scope: "run",
          kind: "user",
          summary: "x",
          body: "y",
          agentId: "writer",
        }),
      ),
    ).rejects.toBeDefined();
  });

  test("list filters by scope and agentId", async () => {
    const mem = createInMemoryMemory();
    await run(mem.put({ scope: "global", kind: "user", summary: "g1", body: "g1" }));
    await run(
      mem.put({ scope: "agent", agentId: "a1", kind: "feedback", summary: "a1", body: "a1" }),
    );
    await run(
      mem.put({ scope: "agent", agentId: "a2", kind: "feedback", summary: "a2", body: "a2" }),
    );
    const onlyA1 = await run(
      mem.list({ scopes: ["global", "agent"], agentId: "a1" }),
    );
    expect(onlyA1.map((e) => e.summary).sort()).toEqual(["a1", "g1"]);
  });

  test("search by query ranks relevant entries", async () => {
    const mem = createInMemoryMemory();
    await run(
      mem.put({
        scope: "global",
        kind: "feedback",
        summary: "Avoid em-dashes",
        body: "Reader detects em-dashes as AI tells.",
        tags: ["style"],
      }),
    );
    await run(
      mem.put({
        scope: "global",
        kind: "reference",
        summary: "TypeBox schema lib",
        body: "drover packages use TypeBox everywhere.",
      }),
    );
    const hits = await run(mem.search({ query: "em-dashes AI tells" }));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.summary).toBe("Avoid em-dashes");
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  test("forget removes the entry", async () => {
    const mem = createInMemoryMemory();
    const e = await run(mem.put({ scope: "global", kind: "user", summary: "x", body: "y" }));
    const removed = await run(mem.forget(e.id));
    expect(removed).toBe(true);
    const got = await run(mem.get(e.id));
    expect(got).toBeNull();
    const again = await run(mem.forget(e.id));
    expect(again).toBe(false);
  });

  test("tag filter matches any overlap", async () => {
    const mem = createInMemoryMemory();
    await run(
      mem.put({ scope: "global", kind: "user", summary: "s", body: "b", tags: ["a", "b"] }),
    );
    await run(
      mem.put({ scope: "global", kind: "user", summary: "t", body: "b", tags: ["c"] }),
    );
    const got = await run(mem.list({ tags: ["b"] }));
    expect(got.length).toBe(1);
    expect(got[0]!.summary).toBe("s");
  });
});
