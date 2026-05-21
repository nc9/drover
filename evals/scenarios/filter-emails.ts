import { Type } from "@sinclair/typebox";
import { defineAgent } from "@drover/core";
import type { Scenario } from "./types.ts";

const LabelSchema = Type.Union([
  Type.Literal("work"),
  Type.Literal("personal"),
  Type.Literal("promotion"),
  Type.Literal("newsletter"),
  Type.Literal("urgent"),
  Type.Literal("spam"),
]);

const spec = defineAgent({
  id: "email-labeler",
  systemPrompt: [
    "You are a Gmail label classifier. For each email you receive, assign 1-3 labels from the allowed set.",
    "Labels: work, personal, promotion, newsletter, urgent, spam.",
    "",
    "Heuristics:",
    "  - 'urgent' is reserved for time-sensitive items (deadlines today, outages, account security).",
    "  - 'promotion' = marketing trying to sell something.",
    "  - 'newsletter' = recurring content from a list you subscribed to.",
    "  - 'work' vs 'personal' is based on sender domain + topic.",
    "  - 'spam' = clearly unsolicited and suspicious.",
    "An email can carry multiple labels (e.g. 'work' + 'urgent').",
  ].join("\n"),
  inputSchema: Type.Object({
    emails: Type.Array(
      Type.Object({
        id: Type.String(),
        from: Type.String(),
        subject: Type.String(),
        snippet: Type.String(),
      }),
      { minItems: 1 },
    ),
  }),
  outputSchema: Type.Object({
    labeled: Type.Array(
      Type.Object({
        id: Type.String(),
        labels: Type.Array(LabelSchema, { minItems: 1, maxItems: 3 }),
        rationale: Type.String({ maxLength: 200 }),
      }),
    ),
  }),
  model: "cheap",
  tools: [],
  quota: { maxTurns: 3 },
});

export const scenario: Scenario<typeof spec> = {
  id: "filter-emails",
  name: "Filter emails with Gmail-style labels",
  category: "data",
  description: "Classify a batch of mock emails into Gmail-style labels.",
  spec,
  input: {
    emails: [
      {
        id: "m1",
        from: "billing@stripe.com",
        subject: "Your monthly invoice is ready",
        snippet: "Your November invoice for $42.00 has been issued and will charge on Nov 30…",
      },
      {
        id: "m2",
        from: "alerts@aws.amazon.com",
        subject: "[ACTION REQUIRED] EC2 instance i-0abc1234 will be retired in 24h",
        snippet: "We are reaching out about an EC2 instance scheduled for retirement on 2026-05-19…",
      },
      {
        id: "m3",
        from: "mom@gmail.com",
        subject: "Dinner Sunday?",
        snippet: "Hey love, are you free for dinner this Sunday at 6? Your dad's making lasagne…",
      },
      {
        id: "m4",
        from: "deals@dominos.co.uk",
        subject: "🍕 30% off any large pizza this week!",
        snippet: "Hungry? Get 30% off any large pizza when you order online. Use code PIZZA30…",
      },
      {
        id: "m5",
        from: "newsletter@stratechery.com",
        subject: "Stratechery Daily Update — The Vibe Coding Bubble",
        snippet: "Today's article looks at the recent surge in vibe-coding tools and whether…",
      },
      {
        id: "m6",
        from: "pm-team@vendor.io",
        subject: "Q4 roadmap review — agenda attached",
        snippet: "Hi team, attaching the agenda for tomorrow's Q4 roadmap sync. Please review…",
      },
      {
        id: "m7",
        from: "security-noreply@github.com",
        subject: "We've detected a sign-in from a new device",
        snippet: "If this wasn't you, secure your account immediately by changing your password…",
      },
      {
        id: "m8",
        from: "winner@l0ttery-prize.net",
        subject: "CONGRATULATIONS!!! You have won $5,000,000",
        snippet: "Dear lucky winner, please click the link below to claim your prize…",
      },
    ],
  },
};
