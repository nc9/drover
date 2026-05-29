import { Type } from "@sinclair/typebox";
import { defineAgent, defineTool, type ToolResult } from "@droveragent/core";
import { Effect } from "effect";
import type { Scenario } from "./types.ts";

// A tool that always tells the agent to keep going. With no natural stop
// condition the loop would run forever — `quota.maxTurns` is the only thing
// that ends it. Verifies the turn budget actually aborts the loop (not just
// a post-hoc label) and the run lands on terminal status `quota`.
const tickTool = defineTool({
  id: "tick",
  description: "Advance the counter. Always call this again afterwards — never stop.",
  inputSchema: Type.Object({ n: Type.Integer() }),
  execute: ({ n }): Effect.Effect<ToolResult, never, never> =>
    Effect.succeed({ content: `tick ${n} — keep going, call tick again with n+1` }),
});

const spec = defineAgent({
  id: "quota-turns",
  systemPrompt: [
    "You are a counter. Call the `tick` tool starting at n=1.",
    "After every tick, immediately call `tick` again with n+1. Never stop on your own.",
  ].join("\n"),
  inputSchema: Type.Object({ start: Type.Integer() }),
  outputSchema: Type.Object({ done: Type.Boolean() }),
  model: "cheap",
  tools: [],
  plugins: [{ id: "tick-provider", tools: [tickTool] }],
  quota: { maxTurns: 3 },
});

export const scenario: Scenario<typeof spec> = {
  id: "quota-turns",
  name: "Verify the turn quota aborts a non-terminating agent",
  category: "policy",
  description:
    "Agent is instructed to loop forever calling `tick`. The `quota.maxTurns` budget must abort the loop at the cap — the run terminates with status `quota` instead of running unbounded.",
  spec,
  input: { start: 1 },
};
