import { describe, expect, test } from "bun:test";
import { LifecycleError, type LifecycleStep } from "@drover/core";
import { type CommandSpec, createCommandRegistry } from "@drover/commands";
import { createPromptEngine } from "@drover/prompt";
import { createSkillRegistry, type SkillSpec } from "@drover/skills";
import type { McpRuntime } from "@drover/mcp";

import { runLifecycleSteps, type RunLifecycleArgs } from "../src/lifecycle.ts";

const engine = createPromptEngine();

const command = (name: string, body: string): CommandSpec => ({
  name,
  description: "d",
  metadata: {},
  body,
  path: `/x/${name}.md`,
  extra: {},
});

const skill = (name: string, body: string): SkillSpec => ({
  name,
  description: "d",
  metadata: {},
  body,
  path: `/x/${name}/SKILL.md`,
  dir: `/x/${name}`,
  extra: {},
});

const fakeMcp = (impl: (name: string) => string): McpRuntime => ({
  tools: () => [],
  servers: () => [],
  callTool: async (name): Promise<string> => impl(name),
  close: async (): Promise<void> => {},
});

const base = (steps: readonly LifecycleStep[]): RunLifecycleArgs => ({
  phase: "init",
  steps,
  runId: "run-1",
  allowedCommands: ["setup", "lint"],
  allowedSkills: ["house-style"],
  allowedMcpServers: ["github"],
  deps: {
    commands: createCommandRegistry([
      command("setup", "Prime {{ repo }}."),
      command("lint", "Lint."),
    ]),
    skills: createSkillRegistry([skill("house-style", "Two-space indent.")]),
    mcpRuntime: fakeMcp((n) => `result for ${n}`),
  },
  engine,
  scope: {},
});

describe("runLifecycleSteps", () => {
  test("prompt step returns its literal text", async () => {
    const blocks = await runLifecycleSteps(base([{ kind: "prompt", text: "hello" }]));
    expect(blocks).toEqual(["hello"]);
  });

  test("command step renders the body with args", async () => {
    const blocks = await runLifecycleSteps(
      base([{ kind: "command", name: "setup", args: { repo: "drover" } }]),
    );
    expect(blocks).toEqual(["Prime drover."]);
  });

  test("skill step pre-expands the body", async () => {
    const blocks = await runLifecycleSteps(base([{ kind: "skill", name: "house-style" }]));
    expect(blocks).toEqual(["## Skill: house-style\n\nTwo-space indent."]);
  });

  test("mcp step injects the call result", async () => {
    const blocks = await runLifecycleSteps(base([{ kind: "mcp", tool: "github__list_issues" }]));
    expect(blocks).toEqual(["## github__list_issues\n\nresult for github__list_issues"]);
  });

  test("steps resolve in order", async () => {
    const blocks = await runLifecycleSteps(
      base([
        { kind: "prompt", text: "one" },
        { kind: "command", name: "lint" },
        { kind: "prompt", text: "three" },
      ]),
    );
    expect(blocks).toEqual(["one", "Lint.", "three"]);
  });

  test("command outside the allowlist throws LifecycleError", async () => {
    await expect(runLifecycleSteps(base([{ kind: "command", name: "deploy" }]))).rejects.toThrow(
      LifecycleError,
    );
  });

  test("command missing from the registry throws LifecycleError", async () => {
    const args = base([{ kind: "command", name: "setup" }]);
    args.deps = { ...args.deps, commands: createCommandRegistry([]) };
    await expect(runLifecycleSteps(args)).rejects.toThrow(/not found/);
  });

  test("command with no registry wired throws LifecycleError", async () => {
    const args = base([{ kind: "command", name: "setup" }]);
    args.deps = {};
    await expect(runLifecycleSteps(args)).rejects.toThrow(/no command registry/);
  });

  test("skill outside the allowlist throws LifecycleError", async () => {
    await expect(
      runLifecycleSteps(base([{ kind: "skill", name: "house-style" }])).then(() => "ok"),
    ).resolves.toBe("ok");
    const args = base([{ kind: "skill", name: "secret" }]);
    await expect(runLifecycleSteps(args)).rejects.toThrow(/allowlist/);
  });

  test("mcp server outside the allowlist throws LifecycleError", async () => {
    await expect(
      runLifecycleSteps(base([{ kind: "mcp", tool: "stripe__charge" }])),
    ).rejects.toThrow(/allowlist/);
  });

  test("a failing mcp call surfaces as a LifecycleError", async () => {
    const args = base([{ kind: "mcp", tool: "github__boom" }]);
    args.deps = {
      ...args.deps,
      mcpRuntime: fakeMcp(() => {
        throw new Error("upstream 500");
      }),
    };
    await expect(runLifecycleSteps(args)).rejects.toThrow(/upstream 500/);
  });

  test("the LifecycleError carries phase and step", async () => {
    try {
      await runLifecycleSteps({
        ...base([{ kind: "command", name: "deploy" }]),
        phase: "postSuccess",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LifecycleError);
      const e = err as LifecycleError;
      expect(e.phase).toBe("postSuccess");
      expect(e.step).toBe("command:deploy");
    }
  });
});
