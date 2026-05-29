import { Type } from "@sinclair/typebox";
import { defineAgent } from "@droveragent/core";
import type { Scenario } from "./types.ts";

const spec = defineAgent({
  id: "rewriter",
  systemPrompt: [
    "You rewrite paragraphs of AI-feeling prose into something a human would actually write.",
    "You have access to skills — call `skill_load(name)` to fetch full instructions for one before you do the rewrite.",
    "ALWAYS load the most relevant skill first; do not improvise the editing rules.",
  ].join("\n"),
  inputSchema: Type.Object({
    text: Type.String({ minLength: 50 }),
  }),
  outputSchema: Type.Object({
    rewrite: Type.String({ minLength: 30 }),
    cuts_applied: Type.Array(Type.String(), { minItems: 1, maxItems: 7 }),
    skill_loaded: Type.String(),
  }),
  model: "cheap",
  tools: [],
  skills: ["grumpy-editor", "factcheck"],
  quota: { maxTurns: 4 },
});

export const scenario: Scenario<typeof spec> = {
  id: "skill-rewrite",
  name: "Rewrite via skill_load",
  category: "skills",
  description:
    "Agent picks the right skill from the allowlist (grumpy-editor vs the decoy factcheck), loads it via skill_load, then applies its rules to a piece of AI-ish prose.",
  fixtureDir: "skills-test",
  spec,
  input: {
    text:
      "In today's rapidly evolving landscape of artificial intelligence, it's important to note that organizations must navigate an intricate tapestry of challenges. Moreover, as such, they should delve into the various potentialities. Furthermore, in conclusion, the future is fast, reliable, and scalable.",
  },
};
