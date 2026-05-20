import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createInMemoryMemory } from "../src/memory.ts";
import {
  loadInstructionFiles,
  renderInstructionsBlock,
  seedInstructionFiles,
} from "../src/instructions.ts";
import { stableId } from "../src/ulid.ts";

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, never, never>);

describe("loadInstructionFiles", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "drover-instr-"));
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.mkdir(path.join(root, "packages/api"), { recursive: true });
    await fs.mkdir(path.join(root, "packages/web"), { recursive: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), "root agents");
    await fs.writeFile(path.join(root, "packages/AGENTS.md"), "packages agents");
    await fs.writeFile(path.join(root, "packages/api/CLAUDE.md"), "api claude");
    await fs.writeFile(path.join(root, "packages/web/AGENTS.md"), "web agents");
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("loads the ancestor chain root-first, excludes off-path files", async () => {
    const files = await loadInstructionFiles({ cwd: path.join(root, "packages/api") });
    expect(files.map((f) => f.content)).toEqual([
      "root agents",
      "packages agents",
      "api claude",
    ]);
    expect(files.some((f) => f.content === "web agents")).toBe(false);
  });

  test("relativeDir is empty at the root", async () => {
    const files = await loadInstructionFiles({ cwd: path.join(root, "packages/api") });
    expect(files[0]!.relativeDir).toBe("");
    expect(files[2]!.relativeDir).toBe(path.join("packages", "api"));
  });

  test("auto-detects root via the nearest .git ancestor", async () => {
    // cwd two levels deep; root not passed — should still stop at the .git
    // dir and include every on-path file (root, packages, packages/web).
    const files = await loadInstructionFiles({ cwd: path.join(root, "packages/web") });
    expect(files.map((f) => f.content)).toEqual([
      "root agents",
      "packages agents",
      "web agents",
    ]);
  });

  test("custom filenames are honoured", async () => {
    await fs.writeFile(path.join(root, "RULES.md"), "custom rules");
    const files = await loadInstructionFiles({
      cwd: root,
      filenames: ["RULES.md"],
    });
    expect(files.map((f) => f.content)).toEqual(["custom rules"]);
  });

  test("oversized files are truncated with a notice", async () => {
    await fs.writeFile(path.join(root, "CLAUDE.md"), "x".repeat(5000));
    const files = await loadInstructionFiles({
      cwd: root,
      filenames: ["CLAUDE.md"],
      maxBytesPerFile: 1000,
    });
    expect(files[0]!.truncated).toBe(true);
    expect(files[0]!.content).toContain("truncated");
  });

  test("no instruction files → empty array", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "drover-bare-"));
    const files = await loadInstructionFiles({ cwd: bare });
    expect(files).toEqual([]);
    await fs.rm(bare, { recursive: true, force: true });
  });
});

describe("renderInstructionsBlock", () => {
  test("emits one section per file, in order", async () => {
    const block = renderInstructionsBlock([
      { path: "/r/AGENTS.md", dir: "/r", relativeDir: "", filename: "AGENTS.md", content: "A", truncated: false },
      {
        path: "/r/pkg/CLAUDE.md",
        dir: "/r/pkg",
        relativeDir: "pkg",
        filename: "CLAUDE.md",
        content: "B",
        truncated: false,
      },
    ]);
    expect(block).toContain("## Project instructions");
    expect(block).toContain("### (repo root) — AGENTS.md");
    expect(block).toContain("### pkg — CLAUDE.md");
    expect(block.indexOf("AGENTS.md")).toBeLessThan(block.indexOf("CLAUDE.md"));
  });

  test("empty input → empty string", () => {
    expect(renderInstructionsBlock([])).toBe("");
  });
});

describe("seedInstructionFiles", () => {
  test("seeds reference entries tagged 'instructions'", async () => {
    const adapter = createInMemoryMemory();
    const files = [
      { path: "/r/AGENTS.md", dir: "/r", relativeDir: "", filename: "AGENTS.md", content: "rules", truncated: false },
    ];
    await run(seedInstructionFiles(adapter, files));
    const listed = await run(adapter.list({ scopes: ["global"], tags: ["instructions"] }));
    expect(listed.length).toBe(1);
    expect(listed[0]!.kind).toBe("reference");
    expect(listed[0]!.body).toBe("rules");
  });

  test("re-seeding the same files is idempotent (stable ids)", async () => {
    const adapter = createInMemoryMemory();
    const files = [
      { path: "/r/AGENTS.md", dir: "/r", relativeDir: "", filename: "AGENTS.md", content: "v1", truncated: false },
    ];
    await run(seedInstructionFiles(adapter, files));
    await run(
      seedInstructionFiles(adapter, [{ ...files[0]!, content: "v2" }]),
    );
    const listed = await run(adapter.list({ scopes: ["global"] }));
    expect(listed.length).toBe(1);
    expect(listed[0]!.body).toBe("v2");
  });

  test("seeds an instruction file larger than the 4000-char learned-memory cap", async () => {
    // A typical CLAUDE.md (~8 KiB) is well over the model-written body
    // limit but must still become a recall-able `reference` entry.
    const adapter = createInMemoryMemory();
    const big = "x".repeat(8000);
    await run(
      seedInstructionFiles(adapter, [
        {
          path: "/r/CLAUDE.md",
          dir: "/r",
          relativeDir: "",
          filename: "CLAUDE.md",
          content: big,
          truncated: false,
        },
      ]),
    );
    const listed = await run(adapter.list({ scopes: ["global"], tags: ["instructions"] }));
    expect(listed.length).toBe(1);
    expect(listed[0]!.body.length).toBe(8000);
  });
});

describe("stableId", () => {
  test("deterministic for a given seed", () => {
    expect(stableId("/r/AGENTS.md")).toBe(stableId("/r/AGENTS.md"));
  });

  test("distinct for different seeds", () => {
    expect(stableId("/r/AGENTS.md")).not.toBe(stableId("/r/CLAUDE.md"));
  });

  test("is a valid ULID-shaped id", () => {
    expect(stableId("anything")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
