import { describe, test, expect } from "bun:test";
import { Type } from "@sinclair/typebox";
import { defineAgent } from "@drover/core";
import { createInMemoryMemory } from "@drover/memory";
import { createSkillRegistry } from "@drover/skills";
import { createNoneSandbox } from "@drover/sandbox";

import { mcpActive, memoryActive, skillsActive, subagentsActive } from "../src/capability-gates.ts";
import type { HarnessDeps } from "../src/deps.ts";

const mkSpec = (over: Record<string, unknown> = {}) =>
  defineAgent({
    id: "x",
    systemPrompt: "p",
    inputSchema: Type.Object({}),
    outputSchema: Type.Object({}),
    model: "m",
    tools: [],
    ...over,
  });

const bare: HarnessDeps = { sandbox: createNoneSandbox() };

describe("capability gates", () => {
  test("subagentsActive: needs both spec.subagents and a registry", () => {
    const registry = { resolve: () => undefined };
    expect(subagentsActive(mkSpec(), bare)).toBe(false);
    expect(subagentsActive(mkSpec({ subagents: { allowed: [] } }), bare)).toBe(false);
    expect(subagentsActive(mkSpec(), { ...bare, agentRegistry: registry })).toBe(false);
    expect(
      subagentsActive(mkSpec({ subagents: { allowed: [] } }), { ...bare, agentRegistry: registry }),
    ).toBe(true);
  });

  test("skillsActive: needs a non-empty skills array and a registry", () => {
    const skills = createSkillRegistry([]);
    expect(skillsActive(mkSpec({ skills: ["a"] }), bare)).toBe(false);
    expect(skillsActive(mkSpec({ skills: [] }), { ...bare, skills })).toBe(false);
    expect(skillsActive(mkSpec({ skills: ["a"] }), { ...bare, skills })).toBe(true);
  });

  test("memoryActive: needs memory.enabled and an adapter", () => {
    const memory = createInMemoryMemory();
    expect(memoryActive(mkSpec({ memory: { enabled: true } }), bare)).toBe(false);
    expect(memoryActive(mkSpec({ memory: { enabled: false } }), { ...bare, memory })).toBe(false);
    expect(memoryActive(mkSpec({ memory: { enabled: true } }), { ...bare, memory })).toBe(true);
  });

  test("mcpActive: needs a non-empty mcpServers array and a runtime", () => {
    const mcpRuntime = {
      servers: () => [],
      tools: () => [],
      callTool: async () => "",
      close: async () => {},
    };
    expect(mcpActive(mkSpec({ mcpServers: ["s"] }), bare)).toBe(false);
    expect(mcpActive(mkSpec({ mcpServers: [] }), { ...bare, mcpRuntime })).toBe(false);
    expect(mcpActive(mkSpec({ mcpServers: ["s"] }), { ...bare, mcpRuntime })).toBe(true);
  });
});
