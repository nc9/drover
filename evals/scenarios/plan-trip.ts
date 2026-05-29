import { Type } from "@sinclair/typebox";
import { defineAgent } from "@droveragent/core";
import type { Scenario } from "./types.ts";

const spec = defineAgent({
  id: "trip-planner",
  systemPrompt: [
    "You produce realistic day-by-day travel itineraries. Stay within budget.",
    "Prefer specific suggestions (named neighbourhoods, museums, dishes) over generic ones.",
    "Each day must have a morning, afternoon, and evening item. Estimate USD totals.",
    "If the destination is unfamiliar to you, do the best you can without making up landmarks.",
  ].join("\n"),
  inputSchema: Type.Object({
    destination: Type.String(),
    days: Type.Integer({ minimum: 1, maximum: 14 }),
    budget_usd: Type.Integer({ minimum: 100 }),
    interests: Type.Array(Type.String(), { maxItems: 5 }),
  }),
  outputSchema: Type.Object({
    destination: Type.String(),
    days: Type.Array(
      Type.Object({
        day: Type.Integer({ minimum: 1 }),
        morning: Type.String({ minLength: 10 }),
        afternoon: Type.String({ minLength: 10 }),
        evening: Type.String({ minLength: 10 }),
        est_cost_usd: Type.Integer({ minimum: 0 }),
      }),
    ),
    total_estimate_usd: Type.Integer({ minimum: 0 }),
    notes: Type.String({ maxLength: 400 }),
  }),
  model: "cheap",
  tools: [],
  quota: { maxTurns: 3 },
});

export const scenario: Scenario<typeof spec> = {
  id: "plan-trip",
  name: "Plan a multi-day trip itinerary",
  category: "generic",
  description: "Free-form planning task with nested structured output.",
  spec,
  input: {
    destination: "Lisbon, Portugal",
    days: 3,
    budget_usd: 600,
    interests: ["food", "history", "design"],
  },
};
