import { Type } from "@sinclair/typebox";
import { defineAgent } from "@drover/core";
import type { Scenario } from "./types.ts";

const spec = defineAgent({
  id: "summariser",
  systemPrompt: [
    "You are an incident-report summariser for an engineering team.",
    "Read the file at the given path with the `read` tool. Produce a 3-bullet summary",
    "(what happened, root cause, top action item) plus an estimated severity reading.",
    "Be terse, factual, no editorialising.",
  ].join("\n"),
  inputSchema: Type.Object({
    file: Type.String(),
  }),
  outputSchema: Type.Object({
    bullets: Type.Array(Type.String({ minLength: 20, maxLength: 240 }), {
      minItems: 3,
      maxItems: 3,
    }),
    severity: Type.Union([
      Type.Literal("SEV1"),
      Type.Literal("SEV2"),
      Type.Literal("SEV3"),
      Type.Literal("SEV4"),
    ]),
    duration_minutes: Type.Integer({ minimum: 0 }),
  }),
  model: "cheap",
  tools: ["read"],
  maxTurns: 4,
});

export const scenario: Scenario<typeof spec> = {
  id: "summarize-doc",
  name: "Summarise an incident report",
  category: "generic",
  description: "Read a doc with the `read` tool and produce a 3-bullet summary + severity tag.",
  fixtureDir: "summarize-doc",
  spec,
  input: { file: "incident.md" },
};
