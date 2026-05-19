import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createMarkdownMemory } from "../src/markdown.ts";

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, never, never>);

describe("createMarkdownMemory", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "drover-mem-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("writes a global entry under <root>/global/<id>.md", async () => {
    const mem = await createMarkdownMemory({ root });
    const entry = await run(
      mem.put({ scope: "global", kind: "user", summary: "hello", body: "world" }),
    );
    const file = path.join(root, "global", `${entry.id}.md`);
    const stat = await fs.stat(file);
    expect(stat.isFile()).toBe(true);
    const content = await fs.readFile(file, "utf8");
    expect(content).toContain("scope: global");
    expect(content).toContain("kind: user");
    expect(content).toContain("summary: hello");
    expect(content).toContain("world");
  });

  test("writes agent and run entries under correct subdirs", async () => {
    const mem = await createMarkdownMemory({ root });
    const a = await run(
      mem.put({
        scope: "agent",
        agentId: "writer",
        kind: "feedback",
        summary: "x",
        body: "y",
      }),
    );
    const r = await run(
      mem.put({
        scope: "run",
        agentId: "writer",
        runId: "run-001",
        kind: "project",
        summary: "x",
        body: "y",
      }),
    );
    expect((await fs.stat(path.join(root, "agents", "writer", `${a.id}.md`))).isFile()).toBe(
      true,
    );
    expect((await fs.stat(path.join(root, "runs", "run-001", `${r.id}.md`))).isFile()).toBe(true);
  });

  test("re-open scans existing entries back into memory", async () => {
    const mem1 = await createMarkdownMemory({ root });
    const e = await run(
      mem1.put({ scope: "global", kind: "user", summary: "persists", body: "across boots" }),
    );
    await run(mem1.close());
    const mem2 = await createMarkdownMemory({ root });
    const got = await run(mem2.get(e.id));
    expect(got?.summary).toBe("persists");
    const listed = await run(mem2.list({ scopes: ["global"] }));
    expect(listed.length).toBe(1);
  });

  test("rejects agentId with path-separator characters", async () => {
    const mem = await createMarkdownMemory({ root });
    await expect(
      run(
        mem.put({
          scope: "agent",
          agentId: "../escape",
          kind: "user",
          summary: "x",
          body: "y",
        }),
      ),
    ).rejects.toBeDefined();
  });

  test("forget removes the file", async () => {
    const mem = await createMarkdownMemory({ root });
    const e = await run(
      mem.put({ scope: "global", kind: "user", summary: "x", body: "y" }),
    );
    const file = path.join(root, "global", `${e.id}.md`);
    expect((await fs.stat(file)).isFile()).toBe(true);
    await run(mem.forget(e.id));
    await expect(fs.stat(file)).rejects.toBeDefined();
  });

  test("update rewrites the file", async () => {
    const mem = await createMarkdownMemory({ root });
    const e = await run(
      mem.put({ scope: "global", kind: "user", summary: "v1", body: "b1" }),
    );
    await new Promise((r) => setTimeout(r, 5));
    await run(
      mem.put({ id: e.id, scope: "global", kind: "user", summary: "v2", body: "b2" }),
    );
    const content = await fs.readFile(
      path.join(root, "global", `${e.id}.md`),
      "utf8",
    );
    expect(content).toContain("summary: v2");
    expect(content).toContain("b2");
    expect(content).toContain("updatedAt:");
  });

  test("scope-changing update writes the new path before unlinking the old", async () => {
    const mem = await createMarkdownMemory({ root });
    const e = await run(
      mem.put({ scope: "global", kind: "user", summary: "v1", body: "b1" }),
    );
    const oldFile = path.join(root, "global", `${e.id}.md`);
    await run(
      mem.put({
        id: e.id,
        scope: "agent",
        agentId: "writer",
        kind: "user",
        summary: "v2",
        body: "b2",
      }),
    );
    const newFile = path.join(root, "agents", "writer", `${e.id}.md`);
    // New file is durable
    expect((await fs.stat(newFile)).isFile()).toBe(true);
    // Old file is cleaned up
    await expect(fs.stat(oldFile)).rejects.toBeDefined();
  });

  test("concurrent writes do not interleave on the same file", async () => {
    const mem = await createMarkdownMemory({ root });
    const e = await run(
      mem.put({ scope: "global", kind: "user", summary: "x", body: "init" }),
    );
    await Promise.all(
      [...Array(5).keys()].map((i) =>
        run(
          mem.put({
            id: e.id,
            scope: "global",
            kind: "user",
            summary: `v${i}`,
            body: `body-${i}`,
          }),
        ),
      ),
    );
    const content = await fs.readFile(
      path.join(root, "global", `${e.id}.md`),
      "utf8",
    );
    // Only one frontmatter block
    const matches = content.match(/^---\s*$/gm) ?? [];
    expect(matches.length).toBe(2);
  });
});
