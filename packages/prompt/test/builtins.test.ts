import { describe, test, expect } from "bun:test";
import { createInMemoryMemory } from "@drover/memory";
import type { InstructionFile } from "@drover/memory";
import { createSkillRegistry } from "@drover/skills";
import type { SkillSpec } from "@drover/skills";
import { Effect } from "effect";

import { createPromptEngine } from "../src/index.ts";

function mkSkill(name: string): SkillSpec {
  return {
    name,
    description: `does ${name} things`,
    metadata: {},
    body: "",
    path: `/skills/${name}/SKILL.md`,
    dir: `/skills/${name}`,
    extra: {},
  };
}

const mkFile = (relativeDir: string, content: string): InstructionFile => ({
  path: `/r/${relativeDir}/AGENTS.md`,
  dir: `/r/${relativeDir}`,
  relativeDir,
  filename: "AGENTS.md",
  content,
  truncated: false,
});

describe("builtins", () => {
  test("{% instructions %} renders the instruction block", async () => {
    const engine = createPromptEngine();
    const r = await engine.render("{% instructions %}", {
      instructions: [mkFile("", "Be concise.")],
    });
    expect(r.text).toContain("## Project instructions");
    expect(r.text).toContain("Be concise.");
  });

  test("{% skills %} renders the skills block from a registry", async () => {
    const engine = createPromptEngine();
    const r = await engine.render("{% skills %}", {
      skills: { registry: createSkillRegistry([mkSkill("deploy")]), allowed: ["deploy"] },
    });
    expect(r.text).toContain("## Available skills");
    expect(r.text).toContain("deploy");
  });

  test("{% memory %} renders the recalled-memory index", async () => {
    const adapter = createInMemoryMemory();
    await Effect.runPromise(
      adapter.put({
        scope: "global",
        kind: "project",
        summary: "deploys use blue-green",
        body: "detail",
      }),
    );
    const engine = createPromptEngine();
    const r = await engine.render("{% memory %}", { memory: { adapter, agentId: "a1" } });
    expect(r.text).toContain("## Recalled memory");
    expect(r.text).toContain("deploys use blue-green");
  });

  test("{% cwd %} / {% runId %} / {% model %} / {% tools %} resolve from scope", async () => {
    const engine = createPromptEngine();
    const r = await engine.render("{% cwd %}|{% runId %}|{% model %}|{% tools %}", {
      run: { runId: "run-7", cwd: "/work" },
      model: "sonnet",
      tools: ["read", "write"],
    });
    expect(r.text).toBe("/work|run-7|sonnet|read, write");
  });
});
