import { describe, test, expect } from "bun:test";
import { Type } from "@sinclair/typebox";

import { defineAgent, defineTool } from "../src/index.ts";
import { Effect } from "effect";

describe("defineAgent", () => {
  test("returns the spec verbatim (identity builder)", () => {
    const spec = defineAgent({
      id: "x",
      systemPrompt: "y",
      inputSchema: Type.Object({ q: Type.String() }),
      outputSchema: Type.Object({ a: Type.String() }),
      model: "cheap",
      tools: [],
    });
    expect(spec.id).toBe("x");
    expect(spec.systemPrompt).toBe("y");
    expect(spec.model).toBe("cheap");
  });

  test("preserves optional fields", () => {
    const spec = defineAgent({
      id: "x",
      systemPrompt: "y",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
      model: "cheap",
      tools: ["bash"],
      skills: ["editor"],
      mcpServers: ["fixture"],
      maxTurns: 7,
      outputRetries: 0,
      timeoutMs: 30_000,
      subagents: { allowed: ["child"], depth: 3, fanOut: 2 },
    });
    expect(spec.maxTurns).toBe(7);
    expect(spec.subagents?.depth).toBe(3);
    expect(spec.timeoutMs).toBe(30_000);
  });
});

describe("defineTool", () => {
  test("schema is preserved on the def", () => {
    const InputSchema = Type.Object({ q: Type.String() });
    const tool = defineTool({
      id: "noop",
      description: "noop",
      inputSchema: InputSchema,
      execute: () =>
        Effect.succeed({ content: "ok" }),
    });
    expect(tool.id).toBe("noop");
    expect(tool.inputSchema).toBe(InputSchema);
  });
});
