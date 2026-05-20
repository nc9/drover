import { describe, test, expect } from "bun:test";
import { Type } from "@sinclair/typebox";
import { defineAgent, type RunContext } from "@drover/core";
import { createInMemoryMemory, type InstructionFile } from "@drover/memory";
import { createPromptEngine } from "@drover/prompt";
import { createSkillRegistry, type SkillSpec } from "@drover/skills";
import { createNoneSandbox } from "@drover/sandbox";
import { Effect } from "effect";

import { buildPromptScope } from "../src/run.ts";

const ctx: RunContext = {
  runId: "run-1",
  depth: 0,
  cwd: "/work",
  env: {},
  signal: new AbortController().signal,
};

const mkSpec = (over: Record<string, unknown> = {}) =>
  defineAgent({
    id: "writer",
    systemPrompt: "base",
    inputSchema: Type.Object({}),
    outputSchema: Type.Object({}),
    model: "cheap",
    tools: ["bash"],
    ...over,
  });

const mkSkill = (name: string): SkillSpec => ({
  name,
  description: `does ${name}`,
  metadata: {},
  body: "",
  path: `/skills/${name}/SKILL.md`,
  dir: `/skills/${name}`,
  extra: {},
});

const mkFile = (content: string): InstructionFile => ({
  path: "/work/AGENTS.md",
  dir: "/work",
  relativeDir: "",
  filename: "AGENTS.md",
  content,
  truncated: false,
});

describe("buildPromptScope", () => {
  test("maps resolved run state into the prompt scope", () => {
    const scope = buildPromptScope({
      spec: mkSpec({ skills: ["deploy"], memory: { enabled: true } }),
      ctx,
      deps: {
        sandbox: createNoneSandbox(),
        skills: createSkillRegistry([mkSkill("deploy")]),
        memory: createInMemoryMemory(),
      },
      modelId: "claude-x",
      toolIds: ["bash", "read"],
      instructionFiles: [mkFile("be terse")],
    });
    expect(scope.agent).toEqual({ id: "writer" });
    expect(scope.run).toEqual({ runId: "run-1", cwd: "/work" });
    expect(scope.model).toBe("claude-x");
    expect(scope.tools).toEqual(["bash", "read"]);
    expect(scope.instructions).toHaveLength(1);
    expect(scope.skills?.allowed).toEqual(["deploy"]);
    expect(scope.memory?.agentId).toBe("writer");
  });

  test("omits skills/memory/instructions when the spec doesn't opt in", () => {
    const scope = buildPromptScope({
      spec: mkSpec(),
      ctx,
      // Deps are wired, but the spec declares neither skills nor memory.
      deps: {
        sandbox: createNoneSandbox(),
        skills: createSkillRegistry([mkSkill("deploy")]),
        memory: createInMemoryMemory(),
      },
      modelId: "m",
      toolIds: [],
      instructionFiles: [],
    });
    expect(scope.skills).toBeUndefined();
    expect(scope.memory).toBeUndefined();
    expect(scope.instructions).toBeUndefined();
  });
});

describe("prompt template rendering through harness scope", () => {
  test("builtins render from the scope buildPromptScope produced", async () => {
    const memory = createInMemoryMemory();
    await Effect.runPromise(
      memory.put({ scope: "global", kind: "project", summary: "blue-green deploys", body: "x" }),
    );
    const scope = buildPromptScope({
      spec: mkSpec({ skills: ["deploy"], memory: { enabled: true } }),
      ctx,
      deps: {
        sandbox: createNoneSandbox(),
        skills: createSkillRegistry([mkSkill("deploy")]),
        memory,
      },
      modelId: "claude-x",
      toolIds: ["bash"],
      instructionFiles: [mkFile("Be concise.")],
    });
    const r = await createPromptEngine().render(
      "Agent {% agent %} on {% model %}.\n{% instructions %}\n{% skills %}\n{% memory %}",
      scope,
    );
    expect(r.text).toContain("Agent writer on claude-x.");
    expect(r.text).toContain("Be concise."); // {% instructions %}
    expect(r.text).toContain("deploy"); // {% skills %}
    expect(r.text).toContain("blue-green deploys"); // {% memory %}
  });
});
