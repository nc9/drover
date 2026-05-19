import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createNoneSandbox } from "@drover/sandbox";
import {
  editTool,
  findTool,
  grepTool,
  lsTool,
  readTool,
  writeTool,
} from "../src/index.ts";

const ctx = (cwd: string) => ({
  runId: "t",
  toolUseId: "tu",
  cwd,
  env: {},
  signal: new AbortController().signal,
  run: {
    runId: "t",
    depth: 0,
    cwd,
    env: {},
    signal: new AbortController().signal,
  },
});

describe("file tools with allowed-roots", () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "drover-tools-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "drover-outside-tools-"));
    await fs.writeFile(path.join(root, "a.txt"), "hello world");
    await fs.writeFile(path.join(outside, "secret"), "shhh");
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  test("read works inside allowedRoots", async () => {
    const sandbox = createNoneSandbox({ allowedRoots: [root] });
    const r = await Effect.runPromise(
      readTool(sandbox).execute({ path: "a.txt" }, ctx(root)),
    );
    expect(r.content).toBe("hello world");
  });

  test("write to new nested path works inside allowedRoots", async () => {
    const sandbox = createNoneSandbox({ allowedRoots: [root] });
    await Effect.runPromise(
      writeTool(sandbox).execute(
        { path: "nested/dir/new.txt", contents: "x" },
        ctx(root),
      ),
    );
    expect(await fs.readFile(path.join(root, "nested/dir/new.txt"), "utf8")).toBe("x");
  });

  test("edit fails when old_string not unique", async () => {
    const sandbox = createNoneSandbox({ allowedRoots: [root] });
    const dupe = path.join(root, "dupe.txt");
    await fs.writeFile(dupe, "needle\nneedle");
    const r = await Effect.runPromise(
      Effect.either(
        editTool(sandbox).execute(
          { path: "dupe.txt", old_string: "needle", new_string: "X" },
          ctx(root),
        ),
      ),
    );
    expect(r._tag).toBe("Left");
  });

  test("edit fails when old_string not found", async () => {
    const sandbox = createNoneSandbox({ allowedRoots: [root] });
    const r = await Effect.runPromise(
      Effect.either(
        editTool(sandbox).execute(
          { path: "a.txt", old_string: "ABSENT", new_string: "Y" },
          ctx(root),
        ),
      ),
    );
    expect(r._tag).toBe("Left");
  });

  test("edit succeeds when old_string unique", async () => {
    const sandbox = createNoneSandbox({ allowedRoots: [root] });
    const file = path.join(root, "uniq.txt");
    await fs.writeFile(file, "unique_marker rest of line");
    await Effect.runPromise(
      editTool(sandbox).execute(
        { path: "uniq.txt", old_string: "unique_marker", new_string: "REPLACED" },
        ctx(root),
      ),
    );
    const after = await fs.readFile(file, "utf8");
    expect(after).toContain("REPLACED");
  });

  test("grep blocked from path outside allowedRoots", async () => {
    const sandbox = createNoneSandbox({ allowedRoots: [root] });
    const r = await Effect.runPromise(
      Effect.either(
        grepTool(sandbox).execute({ pattern: "secret", path: outside }, ctx(root)),
      ),
    );
    expect(r._tag).toBe("Left");
  });

  test("find blocked from path outside allowedRoots", async () => {
    const sandbox = createNoneSandbox({ allowedRoots: [root] });
    const r = await Effect.runPromise(
      Effect.either(findTool(sandbox).execute({ path: outside }, ctx(root))),
    );
    expect(r._tag).toBe("Left");
  });

  test("ls blocked from path outside allowedRoots", async () => {
    const sandbox = createNoneSandbox({ allowedRoots: [root] });
    const r = await Effect.runPromise(
      Effect.either(lsTool(sandbox).execute({ path: outside }, ctx(root))),
    );
    expect(r._tag).toBe("Left");
  });

  test("grep inside allowedRoots works", async () => {
    const sandbox = createNoneSandbox({ allowedRoots: [root] });
    const r = await Effect.runPromise(
      grepTool(sandbox).execute({ pattern: "hello", path: root }, ctx(root)),
    );
    expect(r.content).toContain("hello");
  });
});
