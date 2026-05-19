import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  createSkillRegistry,
  listSkillResources,
  parseAllowedTools,
  parseSkill,
  parseSkillFile,
  readSkillResource,
  renderSkillsBlock,
  scanSkillDirs,
  skillLoadTool,
  skillResourceTool,
  type SkillSpec,
} from "../src/index.ts";

const mkSpec = (over: Partial<SkillSpec> = {}): SkillSpec => ({
  name: "x",
  description: "y",
  body: "",
  path: "/p",
  dir: "/",
  metadata: {},
  extra: {},
  ...over,
});

describe("parseSkill", () => {
  test("parses required fields + body", () => {
    const src = `---
name: editor
description: A skill that edits.
---

# editor

Body content.`;
    const { spec, warnings } = parseSkill(src, "/fake/editor/SKILL.md", { skipParentDirCheck: true });
    expect(spec.name).toBe("editor");
    expect(spec.description).toBe("A skill that edits.");
    expect(spec.body).toContain("Body content.");
    expect(spec.path).toBe("/fake/editor/SKILL.md");
    expect(spec.dir).toBe("/fake/editor");
    expect(warnings.length).toBe(0);
  });

  test("extracts license, compatibility, metadata, allowed-tools", () => {
    const src = `---
name: pdf-processing
description: Extract PDFs.
license: Apache-2.0
compatibility: Requires poppler-utils
metadata:
  author: example-org
  version: "1.0"
allowed-tools: Bash(jq:*) Read
---
body`;
    const { spec } = parseSkill(src, "/x/pdf-processing/SKILL.md", { skipParentDirCheck: true });
    expect(spec.license).toBe("Apache-2.0");
    expect(spec.compatibility).toBe("Requires poppler-utils");
    expect(spec.metadata.author).toBe("example-org");
    expect(spec.metadata.version).toBe("1.0");
    expect(spec.allowedTools).toBe("Bash(jq:*) Read");
  });

  test("non-spec frontmatter goes to extra", () => {
    const src = `---
name: x
description: y
version: 1.2.3
tags: [a, b]
---
body`;
    const { spec } = parseSkill(src, "/x/x/SKILL.md", { skipParentDirCheck: true });
    expect(spec.extra.version).toBe("1.2.3");
    expect(spec.extra.tags).toEqual(["a", "b"]);
    expect(spec.metadata.version).toBeUndefined();
  });

  test("rejects missing frontmatter", () => {
    expect(() => parseSkill("# no frontmatter", "/x", { skipParentDirCheck: true })).toThrow();
  });

  test("rejects missing name", () => {
    expect(() =>
      parseSkill("---\ndescription: ok\n---\n", "/x", { skipParentDirCheck: true }),
    ).toThrow();
  });

  test("rejects missing description", () => {
    expect(() =>
      parseSkill("---\nname: x\n---\n", "/x", { skipParentDirCheck: true }),
    ).toThrow();
  });

  test("rejects invalid name characters", () => {
    const src = `---
name: PDF-Processing
description: x
---`;
    expect(() => parseSkill(src, "/x/PDF-Processing/SKILL.md", { skipParentDirCheck: true })).toThrow();
  });

  test("rejects name with leading hyphen", () => {
    const src = `---
name: -pdf
description: x
---`;
    expect(() => parseSkill(src, "/x/-pdf/SKILL.md", { skipParentDirCheck: true })).toThrow();
  });

  test("rejects consecutive hyphens in name", () => {
    const src = `---
name: pdf--processing
description: x
---`;
    expect(() =>
      parseSkill(src, "/x/pdf--processing/SKILL.md", { skipParentDirCheck: true }),
    ).toThrow();
  });

  test("enforces parent directory match by default", () => {
    const src = `---
name: pdf
description: x
---`;
    expect(() => parseSkill(src, "/x/other-name/SKILL.md")).toThrow(/parent directory/);
  });

  test("rejects description > 1024 chars", () => {
    const src = `---
name: x
description: ${"a".repeat(1025)}
---`;
    expect(() => parseSkill(src, "/x/x/SKILL.md", { skipParentDirCheck: true })).toThrow(/1024/);
  });

  test("rejects compatibility > 500 chars", () => {
    const src = `---
name: x
description: y
compatibility: ${"a".repeat(501)}
---`;
    expect(() => parseSkill(src, "/x/x/SKILL.md", { skipParentDirCheck: true })).toThrow(/500/);
  });

  test("lenient mode collects warnings instead of throwing", () => {
    const src = `---
name: PDF
description: x
---`;
    const { spec, warnings } = parseSkill(src, "/x/wrong/SKILL.md", { mode: "lenient" });
    expect(warnings.length).toBeGreaterThan(0);
    expect(spec.name).toBe("PDF");
  });
});

describe("parseAllowedTools", () => {
  test("space-separated", () => {
    expect(parseAllowedTools("Bash Read Write")).toEqual(["Bash", "Read", "Write"]);
  });

  test("comma-separated", () => {
    expect(parseAllowedTools("Bash, Read, Write")).toEqual(["Bash", "Read", "Write"]);
  });

  test("preserves parenthesised sub-patterns", () => {
    expect(parseAllowedTools("Bash(git:*) Bash(jq:*) Read")).toEqual([
      "Bash(git:*)",
      "Bash(jq:*)",
      "Read",
    ]);
  });

  test("empty / undefined", () => {
    expect(parseAllowedTools(undefined)).toEqual([]);
    expect(parseAllowedTools("")).toEqual([]);
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

  test("lenient mode reports warnings via onIssue but still loads", async () => {
    const bad = await fs.mkdtemp(path.join(os.tmpdir(), "drover-skills-bad-"));
    await fs.mkdir(path.join(bad, "BadName"));
    await fs.writeFile(
      path.join(bad, "BadName/SKILL.md"),
      "---\nname: BadName\ndescription: nope\n---\n",
    );
    const issues: Array<{ file: string; count: number }> = [];
    const skills = await scanSkillDirs([bad], {
      mode: "lenient",
      onIssue: (file, list) => issues.push({ file, count: list.length }),
    });
    expect(skills.length).toBe(1);
    expect(issues.length).toBe(1);
    expect(issues[0]!.count).toBeGreaterThan(0);
    await fs.rm(bad, { recursive: true, force: true });
  });
});

describe("createSkillRegistry", () => {
  test("dedups by name, first wins", () => {
    const reg = createSkillRegistry([
      mkSpec({ name: "a", description: "first", body: "v1" }),
      mkSpec({ name: "a", description: "second", body: "v2" }),
    ]);
    expect(reg.get("a")?.description).toBe("first");
    expect(reg.list().length).toBe(1);
  });
});

describe("listSkillResources / readSkillResource", () => {
  let root: string;
  let spec: SkillSpec;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "drover-skills-res-"));
    const dir = path.join(root, "my-skill");
    await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
    await fs.mkdir(path.join(dir, "references"), { recursive: true });
    await fs.mkdir(path.join(dir, "assets"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      "---\nname: my-skill\ndescription: x\n---\nbody",
    );
    await fs.writeFile(path.join(dir, "scripts/run.py"), "print(1)");
    await fs.writeFile(path.join(dir, "references/REFERENCE.md"), "ref");
    await fs.writeFile(path.join(dir, "assets/template.json"), "{}");
    await fs.writeFile(path.join(dir, "README.md"), "readme");
    spec = parseSkillFile(await fs.readFile(path.join(dir, "SKILL.md"), "utf8"), path.join(dir, "SKILL.md"));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("lists each known directory and other top-level files", async () => {
    const res = await listSkillResources(spec);
    expect(res.scripts).toEqual(["run.py"]);
    expect(res.references).toEqual(["REFERENCE.md"]);
    expect(res.assets).toEqual(["template.json"]);
    expect(res.other).toContain("README.md");
  });

  test("reads a resource under the skill dir", async () => {
    const text = await readSkillResource(spec, "scripts/run.py");
    expect(text).toBe("print(1)");
  });

  test("rejects absolute paths", async () => {
    await expect(readSkillResource(spec, "/etc/passwd")).rejects.toThrow();
  });

  test("rejects '..' escapes", async () => {
    await expect(readSkillResource(spec, "../escape")).rejects.toThrow();
    await expect(readSkillResource(spec, "scripts/../../escape")).rejects.toThrow();
  });
});

describe("skillLoadTool", () => {
  const reg = createSkillRegistry([
    mkSpec({ name: "allowed", description: "d", body: "the body", path: "/p", dir: "/p" }),
    mkSpec({ name: "denied", description: "d", body: "blocked body", path: "/p", dir: "/p" }),
  ]);

  test("returns body for allowed skill", async () => {
    const tool = skillLoadTool({ registry: reg, allowed: ["allowed"], hintResources: false });
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

describe("skillResourceTool", () => {
  let root: string;
  let reg: ReturnType<typeof createSkillRegistry>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "drover-skills-restool-"));
    const dir = path.join(root, "demo");
    await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      "---\nname: demo\ndescription: x\n---\nbody",
    );
    await fs.writeFile(path.join(dir, "scripts/run.sh"), "echo hi");
    const spec = parseSkillFile(
      await fs.readFile(path.join(dir, "SKILL.md"), "utf8"),
      path.join(dir, "SKILL.md"),
    );
    reg = createSkillRegistry([spec]);
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const callTool = async (input: { name: string; resource?: string }): Promise<unknown> => {
    const tool = skillResourceTool({ registry: reg, allowed: ["demo"] });
    return await Effect.runPromise(
      tool.execute(input, {
        runId: "r",
        toolUseId: "t",
        cwd: "/",
        env: {},
        signal: new AbortController().signal,
        run: { runId: "r", depth: 0, cwd: "/", env: {}, signal: new AbortController().signal },
      }),
    );
  };

  test("lists resources without a path", async () => {
    const r = (await callTool({ name: "demo" })) as { content: string; isError?: boolean };
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("scripts/run.sh");
  });

  test("reads a resource", async () => {
    const r = (await callTool({ name: "demo", resource: "scripts/run.sh" })) as {
      content: string;
    };
    expect(r.content).toBe("echo hi");
  });

  test("denies escape attempts", async () => {
    const r = (await callTool({ name: "demo", resource: "../escape" })) as {
      content: string;
      isError?: boolean;
    };
    expect(r.isError).toBe(true);
  });
});

describe("renderSkillsBlock", () => {
  const reg = createSkillRegistry([
    mkSpec({ name: "a", description: "first skill", body: "a body" }),
    mkSpec({ name: "b", description: "second skill", body: "b body" }),
    mkSpec({
      name: "c",
      description: "third skill",
      body: "c body",
      compatibility: "Requires git",
    }),
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

  test("includes compatibility hint when present", () => {
    const block = renderSkillsBlock(reg, ["c"]);
    expect(block).toContain("compatibility: Requires git");
  });
});
