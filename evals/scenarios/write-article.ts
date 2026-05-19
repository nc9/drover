import { Type } from "@sinclair/typebox";
import { defineAgent } from "@drover/core";
import type { Scenario } from "./types.ts";

const spec = defineAgent({
  id: "writer",
  systemPrompt:
    "You are a tech-savvy article writer. Produce concise, fact-grounded posts. Avoid fluff, AI clichés, and made-up statistics. Tags should be lowercase, hyphenated, max 5.",
  inputSchema: Type.Object({
    topic: Type.String({ description: "Article topic" }),
    audience: Type.String({ description: "Who's reading this" }),
    word_target: Type.Integer({ minimum: 150, maximum: 400 }),
  }),
  outputSchema: Type.Object({
    title: Type.String({ minLength: 10, maxLength: 100 }),
    body: Type.String({ minLength: 300 }),
    tags: Type.Array(Type.String(), { minItems: 2, maxItems: 5 }),
  }),
  model: "cheap",
  tools: [],
  maxTurns: 3,
});

export const scenario: Scenario<typeof spec> = {
  id: "write-article",
  name: "Write a short article",
  category: "content",
  description: "Topic → ~250-word article with title and tags. Pure LLM, no tools.",
  spec,
  input: {
    topic: "Why agent harnesses are converging on plugin architectures",
    audience: "engineers building LLM apps in 2026",
    word_target: 250,
  },
};
