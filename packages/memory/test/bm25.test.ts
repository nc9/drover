import { describe, test, expect } from "bun:test";

import { bm25, buildDoc, tokenise } from "../src/bm25.ts";

describe("tokenise", () => {
  test("lowercases and splits on non-word", () => {
    expect(tokenise("Hello, World! 123")).toEqual(["hello", "world", "123"]);
  });

  test("drops stopwords and single-char tokens", () => {
    expect(tokenise("a is the cat")).toEqual(["cat"]);
  });

  test("empty / whitespace input returns []", () => {
    expect(tokenise("")).toEqual([]);
    expect(tokenise("    ")).toEqual([]);
  });
});

describe("bm25", () => {
  const docs = [
    buildDoc("a", "Prefer concise commits", "User wants short subject lines", ["style", "git"]),
    buildDoc("b", "Avoid em-dashes", "Reader treats em-dashes as an AI tell", ["style"]),
    buildDoc("c", "Use TypeBox not Zod", "Schema lib choice across drover packages", ["schema"]),
  ];

  test("ranks expected doc highest", () => {
    const hits = bm25("em-dashes AI tell", docs);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe("b");
  });

  test("returns sorted descending", () => {
    const hits = bm25("commit short", docs);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });

  test("tag matches boost score", () => {
    const hitsTagless = bm25("schema", [buildDoc("x", "Nothing relevant", "irrelevant body", [])]);
    const hitsTagged = bm25("schema", [buildDoc("x", "Nothing relevant", "irrelevant body", ["schema"])]);
    // tagged doc gets the boost even without body match
    expect(hitsTagged.length).toBe(1);
    expect(hitsTagless.length).toBe(0);
  });

  test("empty query returns empty", () => {
    expect(bm25("", docs)).toEqual([]);
  });

  test("empty corpus returns empty", () => {
    expect(bm25("anything", [])).toEqual([]);
  });
});
