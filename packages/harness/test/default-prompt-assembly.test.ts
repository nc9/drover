import { describe, test, expect } from "bun:test";
import { Type } from "@sinclair/typebox";
import { defineAgent, type RunContext } from "@droveragent/core";
import type { McpRuntime } from "@droveragent/mcp";
import { createNoneSandbox } from "@droveragent/sandbox";

import { assembleDefaultPrompt, buildPromptScope } from "../src/run.ts";

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
    tools: [],
    ...over,
  });

const stubMcp: McpRuntime = {
  servers: () => [{ id: "github", transport: "stdio", toolCount: 1 }],
  tools: (allowed) =>
    !allowed || allowed.includes("github") ? [{ id: "github__create_issue" } as never] : [],
  callTool: async () => "",
  close: async () => {},
};

const scopeFor = (
  spec: ReturnType<typeof mkSpec>,
  deps: Parameters<typeof buildPromptScope>[0]["deps"],
) => buildPromptScope({ spec, ctx, deps, modelId: "claude-x", toolIds: [], instructionFiles: [] });

describe("assembleDefaultPrompt", () => {
  test("nothing wired → basePrompt + the always-on environment block only", async () => {
    const scope = scopeFor(mkSpec(), { sandbox: createNoneSandbox() });
    const { text } = await assembleDefaultPrompt("BASE PROMPT", scope);
    expect(text.startsWith("BASE PROMPT\n\n## Environment")).toBe(true);
    expect(text).not.toContain("## Subagents");
    expect(text).not.toContain("## MCP servers");
    expect(text).not.toContain("## Available skills");
    expect(text).not.toContain("## Recalled memory");
  });

  test("subagents + mcp wired → both capability fragments appear", async () => {
    const child = mkSpec({ id: "researcher", description: "digs up facts" });
    const scope = scopeFor(
      mkSpec({ subagents: { allowed: ["researcher"] }, mcpServers: ["github"] }),
      {
        sandbox: createNoneSandbox(),
        agentRegistry: { resolve: (id) => (id === "researcher" ? child : undefined) },
        mcpRuntime: stubMcp,
      },
    );
    const { text } = await assembleDefaultPrompt("BASE", scope);
    expect(text).toContain("## Subagents");
    expect(text).toContain("- researcher: digs up facts");
    expect(text).toContain("## MCP servers");
    expect(text).toContain("- github__create_issue");
    expect(text).toContain("## Environment");
  });

  test("no stray blank-line runs of 3+ newlines", async () => {
    const child = mkSpec({ id: "researcher" });
    const scope = scopeFor(
      mkSpec({ subagents: { allowed: ["researcher"] }, mcpServers: ["github"] }),
      {
        sandbox: createNoneSandbox(),
        agentRegistry: { resolve: () => child },
        mcpRuntime: stubMcp,
      },
    );
    const { text } = await assembleDefaultPrompt("BASE", scope);
    expect(text).not.toMatch(/\n{3,}/);
  });

  test("basePrompt with literal {% %} / {{ }} passes through verbatim (never Liquid-parsed)", async () => {
    const scope = scopeFor(mkSpec(), { sandbox: createNoneSandbox() });
    const base = "Use {% raw %} blocks and a {{ placeholder }} literally.";
    const { text } = await assembleDefaultPrompt(base, scope);
    expect(text.startsWith(base)).toBe(true);
  });

  test("empty basePrompt → fragments only, no leading blank line", async () => {
    const scope = scopeFor(mkSpec(), { sandbox: createNoneSandbox() });
    const { text } = await assembleDefaultPrompt("", scope);
    expect(text.startsWith("## Environment")).toBe(true);
  });

  test("cache report describes the FINAL prompt, basePrompt included", async () => {
    const scope = scopeFor(mkSpec(), { sandbox: createNoneSandbox() });
    const { text, cache } = await assembleDefaultPrompt("BASE PROMPT", scope);
    expect(cache.totalChars).toBe(text.length);
    // basePrompt is static + prepended → counts toward the cacheable prefix.
    expect(cache.cacheablePrefixChars).toBe("BASE PROMPT".length);
    // environment is volatile + always-on → prompt is never fully cacheable.
    expect(cache.cacheablePrefixChars).toBeLessThan(cache.totalChars);
  });

  test("cacheablePrefixChars is a real offset splitting static from volatile", async () => {
    const child = mkSpec({ id: "researcher" });
    const scope = scopeFor(mkSpec({ subagents: { allowed: ["researcher"] } }), {
      sandbox: createNoneSandbox(),
      agentRegistry: { resolve: () => child },
    });
    const { text, cache } = await assembleDefaultPrompt("BASE", scope);
    const prefix = text.slice(0, cache.cacheablePrefixChars);
    expect(prefix).toContain("## Subagents"); // static fragment — in prefix
    expect(prefix).not.toContain("## Environment"); // volatile — excluded
    expect(text.slice(cache.cacheablePrefixChars)).toContain("## Environment");
  });
});
