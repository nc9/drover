import { Type } from "@sinclair/typebox";
import { defineAgent } from "@drover/core";
import type { Scenario } from "./types.ts";

// Child agent: a focused researcher that returns 3 talking points.
export const researcherSpec = defineAgent({
  id: "researcher",
  systemPrompt:
    "You are a quick-research subagent. Given a narrow topic, return EXACTLY 3 concise talking points (one sentence each). No preamble, no caveats. Be concrete.",
  inputSchema: Type.Object({ prompt: Type.String() }),
  outputSchema: Type.Object({
    topic: Type.String(),
    points: Type.Array(Type.String({ minLength: 20, maxLength: 200 }), {
      minItems: 3,
      maxItems: 3,
    }),
  }),
  model: "cheap",
  tools: [],
  quota: { maxTurns: 2 },
});

// Parent agent: a planner that decomposes a question into 2 sub-topics
// and spawns a researcher for each via the `task` tool.
const plannerSpec = defineAgent({
  id: "planner",
  systemPrompt: [
    "You break down a complex question into focused sub-topics, then call the `task` tool to spawn a `researcher` subagent for each. After the children return, synthesise their findings into a final answer.",
    "",
    "Steps:",
    "  1. Identify 2 distinct sub-topics that together cover the question.",
    "  2. For each sub-topic, call `task` with agent_type='researcher' and a focused prompt.",
    "  3. Read both children's outputs (3 talking points each) and merge into your final synthesis.",
    "",
    "Do NOT answer from your own knowledge — the children must do the work.",
  ].join("\n"),
  inputSchema: Type.Object({ question: Type.String() }),
  outputSchema: Type.Object({
    question: Type.String(),
    sub_topics_explored: Type.Array(Type.String(), { minItems: 2, maxItems: 4 }),
    synthesis: Type.String({ minLength: 100, maxLength: 1500 }),
    children_used: Type.Integer({ minimum: 1 }),
  }),
  model: "cheap",
  tools: [],
  subagents: { depth: 2, fanOut: 2, allowed: ["researcher"] },
  quota: { maxTurns: 6 },
});

export const scenario: Scenario<typeof plannerSpec> = {
  id: "research-with-subagent",
  name: "Plan + research via subagent",
  category: "research",
  description:
    "Planner decomposes a question, spawns researcher subagents via the auto-injected `task` tool, then synthesises.",
  spec: plannerSpec,
  input: {
    question: "How are agent harnesses evolving — what's converging, what's diverging?",
  },
};
