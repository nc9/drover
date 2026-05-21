import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { CommandLoadError, parseCommand, scanCommandDirs } from "../src/index.ts";

describe("parseCommand", () => {
  test("parses a valid command", () => {
    const md = `---
name: setup
description: Prime the run with project context.
argument-hint: "{ repo: string }"
metadata:
  author: nik
---

Read {{ repo }} and summarise its structure.`;
    const { spec, warnings } = parseCommand(md, "/x/setup.md");
    expect(warnings).toHaveLength(0);
    expect(spec.name).toBe("setup");
    expect(spec.description).toBe("Prime the run with project context.");
    expect(spec.argumentHint).toBe("{ repo: string }");
    expect(spec.metadata).toEqual({ author: "nik" });
    expect(spec.body).toBe("Read {{ repo }} and summarise its structure.");
  });

  test("derives name from the filename when frontmatter omits it", () => {
    const md = `---
description: A command.
---

body`;
    const { spec } = parseCommand(md, "/cmds/lint-and-commit.md");
    expect(spec.name).toBe("lint-and-commit");
  });

  test("frontmatter name overrides the filename", () => {
    const md = `---
name: real-name
description: A command.
---
body`;
    const { spec } = parseCommand(md, "/cmds/file-name.md");
    expect(spec.name).toBe("real-name");
  });

  test("throws on missing frontmatter", () => {
    expect(() => parseCommand("just a body", "/x/c.md")).toThrow(CommandLoadError);
  });

  test("throws on missing description", () => {
    const md = `---
name: c
---
body`;
    expect(() => parseCommand(md, "/x/c.md")).toThrow(/description/);
  });

  test("throws on an invalid name", () => {
    const md = `---
description: A command.
---
body`;
    expect(() => parseCommand(md, "/x/Bad_Name.md")).toThrow(/name/);
  });

  test("lenient mode collects issues instead of throwing", () => {
    const md = `---
name: c
---
body`;
    const { warnings } = parseCommand(md, "/x/c.md", { mode: "lenient" });
    expect(warnings.some((w) => w.field === "description")).toBe(true);
  });
});

describe("scanCommandDirs", () => {
  let root: string;
  let shared: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "drover-cmd-"));
    shared = await fs.mkdtemp(path.join(os.tmpdir(), "drover-cmd-shared-"));
    await fs.writeFile(
      path.join(root, "setup.md"),
      "---\ndescription: local setup\n---\nlocal body",
    );
    await fs.writeFile(
      path.join(shared, "setup.md"),
      "---\ndescription: shared setup\n---\nshared body",
    );
    await fs.writeFile(
      path.join(shared, "deploy.md"),
      "---\ndescription: deploy\n---\ndeploy body",
    );
    await fs.writeFile(path.join(root, "_draft.md"), "not a command");
    await fs.writeFile(path.join(root, "notes.txt"), "ignored");
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(shared, { recursive: true, force: true });
  });

  test("scans flat .md files, skips non-md and underscore-prefixed", async () => {
    const cmds = await scanCommandDirs([shared]);
    expect(cmds.map((c) => c.name).sort()).toEqual(["deploy", "setup"]);
  });

  test("first root wins on name collision", async () => {
    const cmds = await scanCommandDirs([root, shared]);
    const setup = cmds.find((c) => c.name === "setup");
    expect(setup?.description).toBe("local setup");
  });
});
