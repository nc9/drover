import { Type } from "@sinclair/typebox";
import { defineAgent } from "@drover/core";
import type { Scenario } from "./types.ts";

const spec = defineAgent({
  id: "mcp-user",
  systemPrompt: [
    "You answer the user's question by calling external tools when math or lookups are involved.",
    "Available MCP tools are prefixed `fixture__<name>` (e.g. `fixture__compute`, `fixture__weather`).",
    "Do not guess numeric answers — call `fixture__compute` for any arithmetic.",
    "Do not invent weather — call `fixture__weather` for it.",
  ].join("\n"),
  inputSchema: Type.Object({
    question: Type.String(),
  }),
  outputSchema: Type.Object({
    answer: Type.String({ minLength: 2 }),
    tools_used: Type.Array(Type.String(), { minItems: 1 }),
  }),
  model: "cheap",
  tools: [],
  mcpServers: ["fixture"],
  maxTurns: 6,
});

export const scenario: Scenario<typeof spec> = {
  id: "mcp-roundtrip",
  name: "Use tools from a fixture MCP stdio server",
  category: "mcp",
  description:
    "Spawns an in-repo MCP stdio server with `compute` + `weather` tools. Agent calls them via prefixed names, returns the answer + which tools it used.",
  spec,
  input: {
    question:
      "What's 17 * (3 + 5)? Also, what's the weather in Lisbon today? Use the tools.",
  },
};
