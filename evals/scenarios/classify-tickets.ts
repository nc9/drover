import { Type } from "@sinclair/typebox";
import { defineAgent } from "@drover/core";
import type { Scenario } from "./types.ts";

const spec = defineAgent({
  id: "ticket-classifier",
  systemPrompt: [
    "You triage incoming support tickets for a B2B SaaS.",
    "Assign category and priority for each ticket. Definitions:",
    "  category: one of 'bug' | 'feature_request' | 'question' | 'complaint' | 'billing'.",
    "  priority: 'p0' (production outage), 'p1' (workflow blocked), 'p2' (degraded), 'p3' (cosmetic / nice-to-have).",
    "Customers writing in caps about churn-risk = consider p1+ even if technically a complaint.",
  ].join("\n"),
  inputSchema: Type.Object({
    tickets: Type.Array(
      Type.Object({
        id: Type.String(),
        subject: Type.String(),
        body: Type.String(),
        plan: Type.Union([Type.Literal("free"), Type.Literal("pro"), Type.Literal("enterprise")]),
      }),
    ),
  }),
  outputSchema: Type.Object({
    triaged: Type.Array(
      Type.Object({
        id: Type.String(),
        category: Type.Union([
          Type.Literal("bug"),
          Type.Literal("feature_request"),
          Type.Literal("question"),
          Type.Literal("complaint"),
          Type.Literal("billing"),
        ]),
        priority: Type.Union([
          Type.Literal("p0"),
          Type.Literal("p1"),
          Type.Literal("p2"),
          Type.Literal("p3"),
        ]),
      }),
    ),
  }),
  model: "cheap",
  tools: [],
  maxTurns: 2,
});

export const scenario: Scenario<typeof spec> = {
  id: "classify-tickets",
  name: "Triage support tickets",
  category: "data",
  description: "Category + priority for a batch of incoming support tickets.",
  spec,
  input: {
    tickets: [
      {
        id: "t1",
        subject: "Dashboard 502 on every page load",
        body: "Since this morning our entire ops team can't get into the dashboard. Just a 502 page. We're on Enterprise.",
        plan: "enterprise",
      },
      {
        id: "t2",
        subject: "Can you add dark mode?",
        body: "Light theme hurts my eyes. Pls.",
        plan: "free",
      },
      {
        id: "t3",
        subject: "Charged twice this month",
        body: "I see two invoices on the same day for the same amount on the Pro plan. Please refund one.",
        plan: "pro",
      },
      {
        id: "t4",
        subject: "How do I export to CSV?",
        body: "Couldn't find it in the UI. Is there an API endpoint?",
        plan: "pro",
      },
      {
        id: "t5",
        subject: "THIS IS RIDICULOUS — cancelling our contract",
        body: "Third outage this month. We're moving to a competitor. Want to talk to someone TODAY.",
        plan: "enterprise",
      },
      {
        id: "t6",
        subject: "Logo is misaligned on the settings page",
        body: "Minor visual thing, the logo overlaps the nav on Safari. Low-pri.",
        plan: "pro",
      },
    ],
  },
};
