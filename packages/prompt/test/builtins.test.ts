import { describe, test, expect } from "bun:test";
import { createInMemoryMemory } from "@drover/memory";
import type { InstructionFile } from "@drover/memory";
import { createSkillRegistry } from "@drover/skills";
import type { SkillSpec } from "@drover/skills";
import { Effect } from "effect";

import { createPromptEngine, DEFAULT_PROMPT_TEMPLATE, getBuiltin } from "../src/index.ts";

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

describe("capability fragments", () => {
  test("{% subagents %} lists allowed agents + caps", async () => {
    const engine = createPromptEngine();
    const r = await engine.render("{% subagents %}", {
      subagents: {
        allowed: [
          { id: "researcher", description: "Gathers source material." },
          { id: "reviewer" },
        ],
        maxDepth: 2,
        fanOut: 3,
      },
    });
    expect(r.text).toContain("## Subagents");
    expect(r.text).toContain("`task`");
    expect(r.text).toContain("- researcher: Gathers source material.");
    expect(r.text).toContain("- reviewer");
    expect(r.text).not.toContain("- reviewer:");
    expect(r.text).toContain("nesting depth 2");
    expect(r.text).toContain("up to 3 concurrent");
  });

  test("{% subagents %} renders '' when absent or empty", async () => {
    const engine = createPromptEngine();
    expect((await engine.render("{% subagents %}", {})).text).toBe("");
    expect(
      (
        await engine.render("{% subagents %}", {
          subagents: { allowed: [], maxDepth: 2, fanOut: 3 },
        })
      ).text,
    ).toBe("");
  });

  test("{% mcp %} lists servers + prefixed tools", async () => {
    const engine = createPromptEngine();
    const r = await engine.render("{% mcp %}", {
      mcp: {
        servers: [
          { id: "github", tools: ["github__create_issue", "github__list_prs"] },
          { id: "empty", tools: [] },
        ],
      },
    });
    expect(r.text).toContain("## MCP servers");
    expect(r.text).toContain("<serverId>__<toolName>");
    expect(r.text).toContain("### github");
    expect(r.text).toContain("- github__create_issue");
    expect(r.text).toContain("### empty");
    expect(r.text).toContain("(no tools available)");
  });

  test("{% mcp %} renders '' when absent or empty", async () => {
    const engine = createPromptEngine();
    expect((await engine.render("{% mcp %}", {})).text).toBe("");
    expect((await engine.render("{% mcp %}", { mcp: { servers: [] } })).text).toBe("");
  });

  test("{% environment %} renders execution facts", async () => {
    const engine = createPromptEngine();
    const r = await engine.render("{% environment %}", {
      run: { runId: "r1", cwd: "/work/repo" },
      model: "sonnet",
      environment: { sandboxId: "just-bash" },
    });
    expect(r.text).toContain("## Environment");
    expect(r.text).toContain("- Working directory: /work/repo");
    expect(r.text).toContain("- Model: sonnet");
    expect(r.text).toContain("- Sandbox: just-bash");
    expect(r.text).toMatch(/- Date: \d{4}-\d{2}-\d{2}/);
  });

  test("{% environment %} always emits at least the date line", async () => {
    const engine = createPromptEngine();
    const r = await engine.render("{% environment %}", {});
    expect(r.text).toContain("## Environment");
    expect(r.text).toMatch(/- Date: \d{4}-\d{2}-\d{2}/);
    expect(r.text).not.toContain("Working directory");
  });

  test("capability builtins declare the right volatility", () => {
    expect(getBuiltin("subagents")?.volatility).toBe("static");
    expect(getBuiltin("mcp")?.volatility).toBe("static");
    expect(getBuiltin("environment")?.volatility).toBe("volatile");
  });

  test("DEFAULT_PROMPT_TEMPLATE uses only registered builtins, static-before-volatile", () => {
    const tags = [...DEFAULT_PROMPT_TEMPLATE.matchAll(/\{%\s*(\w+)\s*%\}/g)].map((m) => m[1]!);
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(getBuiltin(t)).toBeDefined();
    const firstVolatile = tags.findIndex((t) => getBuiltin(t)!.volatility === "volatile");
    if (firstVolatile >= 0) {
      for (let i = firstVolatile; i < tags.length; i++) {
        expect(getBuiltin(tags[i]!)!.volatility).toBe("volatile");
      }
    }
  });
});
