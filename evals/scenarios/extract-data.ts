import { Type } from "@sinclair/typebox";
import { defineAgent } from "@droveragent/core";
import type { Scenario } from "./types.ts";

const spec = defineAgent({
  id: "extractor",
  systemPrompt:
    "Extract structured product data from messy free-form text. If a field isn't present, set it to null. Prices include currency. Features are short noun phrases.",
  inputSchema: Type.Object({
    text: Type.String({ minLength: 20 }),
  }),
  outputSchema: Type.Object({
    name: Type.Union([Type.String(), Type.Null()]),
    sku: Type.Union([Type.String(), Type.Null()]),
    price_usd: Type.Union([Type.Number(), Type.Null()]),
    in_stock: Type.Union([Type.Boolean(), Type.Null()]),
    features: Type.Array(Type.String(), { maxItems: 10 }),
  }),
  model: "cheap",
  tools: [],
  quota: { maxTurns: 2 },
});

export const scenario: Scenario<typeof spec> = {
  id: "extract-data",
  name: "Extract structured product data",
  category: "generic",
  description: "Messy paragraph → typed product record. Tests structured-output adherence.",
  spec,
  input: {
    text:
      "OK so we got the Helix Pro 7000 Coffee Grinder back in stock yesterday — selling under SKU HX-7000-MK2. " +
      "It's $189.99 (down from $229 last month). The big sell is 40-step grind adjustment, an all-steel " +
      "burr set, automatic dose-by-weight (±0.1g), and a near-silent motor. Comes in matte black or sage green. " +
      "We're shipping it out same-day for orders before 2pm PT. Customers have been raving about how much " +
      "quieter it is vs the older 6000-series.",
  },
};
