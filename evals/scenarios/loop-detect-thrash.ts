import { Type } from "@sinclair/typebox";
import { defineAgent, defineTool, type ToolResult } from "@drover/core";
import { loopDetectPlugin } from "@drover/plugins";
import { Effect } from "effect";
import type { Scenario } from "./types.ts";

// A tool that always returns the same wrong answer, baiting the agent
// into a retry loop. loop-detect should catch it within 3 calls.
const flakySearch = defineTool({
  id: "flaky_search",
  description:
    "Search a tiny knowledge base. Returns one result per query. Note: known to be flaky — sometimes returns the wrong record.",
  inputSchema: Type.Object({ query: Type.String() }),
  execute: (): Effect.Effect<ToolResult, never, never> =>
    Effect.succeed({
      content: JSON.stringify({
        match: "lorem ipsum dolor sit amet",
        confidence: 0.1,
        note: "tool internal error: index stale",
      }),
      isError: false,
    }),
});

const spec = defineAgent({
  id: "thrasher",
  systemPrompt: [
    "You answer the user's question by calling `flaky_search`. The tool is unreliable — when the result looks wrong, try again with a different query.",
    "If you call the tool too many times with the same query, the system will refuse — that's your cue that the tool isn't going to help.",
    "When you decide to stop, return a JSON object explaining whether you got an answer and how many tool calls you made.",
  ].join("\n"),
  inputSchema: Type.Object({ question: Type.String() }),
  outputSchema: Type.Object({
    answer: Type.Union([Type.String(), Type.Null()]),
    tool_calls_made: Type.Integer({ minimum: 0 }),
    gave_up: Type.Boolean(),
    reason: Type.String(),
  }),
  model: "cheap",
  tools: [],
  plugins: [
    loopDetectPlugin({ window: 3, ignoreInput: true }),
    {
      id: "flaky-search-provider",
      tools: [flakySearch],
    },
  ],
  quota: { maxTurns: 8 },
});

export const scenario: Scenario<typeof spec> = {
  id: "loop-detect-thrash",
  name: "Verify loop-detect plugin breaks a thrashing agent",
  category: "policy",
  description:
    "Agent uses a tool that always returns the wrong answer; loopDetectPlugin must cut off the third identical call.",
  spec,
  input: {
    question: "What is the capital of France?",
  },
};
