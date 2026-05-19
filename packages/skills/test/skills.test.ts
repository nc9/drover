import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  createSkillRegistry,
  parseSkillFile,
  scanSkillDirs,
  skillLoadTool,
  renderSkillsBlock,
} from "../src/index.ts";

describe("parseSkillFile", () => {
  test("parses name + description + body", () => {
    const src = `---
name: editor
description: A skill that edits.
---

# editor

Body content.`;
    const spec = parseSkillFile(src, "/fake/path");
    expect(spec.name).toBe("editor");
    expect(spec.description).toBe("A skill that edits.");
    expect(spec.body).toContain("Body content.");
    expect(spec.path).toBe("/fake/path");
  });

  test("rejects missing frontmatter", () => {
    expect(() => parseSkillFile("# no frontmatter", "/x")).toThrow();
  });

  test("rejects missing name", () => {
    expect(() => parseSkillFile("---\ndescription: ok\n---\n", "/x")).toThrow();
  });

  test("rejects missing description", () => {
    expect(() => parseSkillFile("---\nname: x\n---\n", "/x")).toThrow();
  });

  test("preserves extra metadata fields", () => {
    const src = `---
name: x
description: y
version: 1.2.3
tags: [a, b]
---
body`;
    const spec = parseSkillFile(src, "/x");
    expect(spec.metadata.version).toBe("1.2.3");
    expect(spec.metadata.tags).toEqual(["a", "b"]);
  });
});

describe("scanSkillDirs", () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "drover-skills-test-"));
    await fs.mkdir(path.join(root, "one"));
    await fs.writeFile(
      path.join(root, "one/SKILL.md"),
      "---\nname: one\ndescription: first\n---\nbody one",
    );
    await fs.mkdir(path.join(root, "two"));
    await fs.writeFile(
      path.join(root, "two/SKILL.md"),
      "---\nname: two\ndescription: second\n---\nbody two",
    );
    await fs.mkdir(path.join(root, ".hidden"));
    await fs.writeFile(
      path.join(root, ".hidden/SKILL.md"),
      "---\nname: hidden\ndescription: should be skipped\n---\n",
    );
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("finds skill files in subdirs", async () => {
    const skills = await scanSkillDirs([root]);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["one", "two"]);
  });

  test("skips dot-prefixed dirs", async () => {
    const skills = await scanSkillDirs([root]);
    expect(skills.find((s) => s.name === "hidden")).toBeUndefined();
  });

  test("absent root is silently ignored", async () => {
    const skills = await scanSkillDirs(["/nonexistent-dir-12345"]);
    expect(skills.length).toBe(0);
  });
});

describe("createSkillRegistry", () => {
  test("dedups by name, first wins", () => {
    const reg = createSkillRegistry([
      { name: "a", description: "first", body: "v1", path: "/p1", metadata: {} },
      { name: "a", description: "second", body: "v2", path: "/p2", metadata: {} },
    ]);
    expect(reg.get("a")?.description).toBe("first");
    expect(reg.list().length).toBe(1);
  });
});

describe("skillLoadTool", () => {
  const reg = createSkillRegistry([
    { name: "allowed", description: "d", body: "the body", path: "/p", metadata: {} },
    { name: "denied", description: "d", body: "blocked body", path: "/p", metadata: {} },
  ]);

  test("returns body for allowed skill", async () => {
    const tool = skillLoadTool({ registry: reg, allowed: ["allowed"] });
    const r = await Effect.runPromise(
      tool.execute(
        { name: "allowed" },
        {
          runId: "r",
          toolUseId: "t",
          cwd: "/",
          env: {},
          signal: new AbortController().signal,
          run: { runId: "r", depth: 0, cwd: "/", env: {}, signal: new AbortController().signal },
        },
      ),
    );
    expect(r.content).toBe("the body");
    expect(r.isError).toBeUndefined();
  });

  test("denies disallowed skill", async () => {
    const tool = skillLoadTool({ registry: reg, allowed: ["allowed"] });
    const r = await Effect.runPromise(
      tool.execute(
        { name: "denied" },
        {
          runId: "r",
          toolUseId: "t",
          cwd: "/",
          env: {},
          signal: new AbortController().signal,
          run: { runId: "r", depth: 0, cwd: "/", env: {}, signal: new AbortController().signal },
        },
      ),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not available");
  });
});

describe("renderSkillsBlock", () => {
  const reg = createSkillRegistry([
    { name: "a", description: "first skill", body: "a body", path: "/", metadata: {} },
    { name: "b", description: "second skill", body: "b body", path: "/", metadata: {} },
  ]);

  test("renders only allowed skills", () => {
    const block = renderSkillsBlock(reg, ["a"]);
    expect(block).toContain("a: first skill");
    expect(block).not.toContain("b:");
  });

  test("empty allowed list returns empty string", () => {
    expect(renderSkillsBlock(reg, [])).toBe("");
  });

  test("skill not in registry is silently skipped", () => {
    const block = renderSkillsBlock(reg, ["missing"]);
    expect(block).toBe("");
  });
});
