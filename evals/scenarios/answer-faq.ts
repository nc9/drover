import { Type } from "@sinclair/typebox";
import { defineAgent } from "@droveragent/core";
import type { Scenario } from "./types.ts";

const spec = defineAgent({
  id: "faq-answerer",
  systemPrompt: [
    "You answer questions grounded ONLY in the provided context. Do not use outside knowledge.",
    "If the answer isn't in the context, set `answer` to 'I don't know' and confidence='low'.",
    "Keep answers under 2 sentences. Cite the relevant phrase verbatim in `evidence`.",
  ].join("\n"),
  inputSchema: Type.Object({
    question: Type.String(),
    context: Type.String({ minLength: 50 }),
  }),
  outputSchema: Type.Object({
    answer: Type.String({ minLength: 2, maxLength: 400 }),
    evidence: Type.String(),
    confidence: Type.Union([
      Type.Literal("high"),
      Type.Literal("medium"),
      Type.Literal("low"),
    ]),
  }),
  model: "cheap",
  tools: [],
  quota: { maxTurns: 2 },
});

export const scenario: Scenario<typeof spec> = {
  id: "answer-faq",
  name: "Context-grounded Q&A",
  category: "generic",
  description: "Reading-comprehension task: answer using only the given context.",
  spec,
  input: {
    question: "What is the refund window for annual plans, and does it differ from monthly?",
    context: [
      "Refund policy (effective 2026-03-01):",
      "- Monthly subscribers may request a full refund within 14 days of any charge by emailing support@example.com.",
      "- Annual subscribers may request a pro-rated refund within 30 days of the initial purchase only — renewals are non-refundable.",
      "- Trial conversions inherit the policy of the plan the user converts into.",
      "- Add-ons (extra seats, storage tiers) are non-refundable once provisioned.",
    ].join("\n"),
  },
};
