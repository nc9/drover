// Exercises the memory wiring. Pre-seeds the in-process memory adapter
// with one global-scope fact, runs a memory-enabled agent that should
// either surface the seeded fact (via the auto-injected index) or call
// `recall` to fetch it. Memory adapter, tool injection, and event
// surfacing are all under test — model behaviour ("did it remember?")
// is graded by the structured output.
//
// Wired via a custom hook in evals/run.ts (sets up the adapter + passes
// it as deps.memory) rather than the standard runner path.

import { Type } from "@sinclair/typebox";
import { defineAgent } from "@drover/core";

export const memoryAgent = defineAgent({
  id: "memory-self-learn",
  systemPrompt: [
    "You answer one question. If 'Recalled memory' appears in your system prompt, prefer",
    "those facts. If you don't see a relevant memory, call `recall(query=<terms>)` first.",
    "After answering, if the user revealed a new lesson worth keeping, call `remember`.",
  ].join(" "),
  inputSchema: Type.Object({
    question: Type.String(),
  }),
  outputSchema: Type.Object({
    answer: Type.String({ minLength: 1, maxLength: 400 }),
    used_memory: Type.Boolean(),
    /** Lower-cased memory id(s) the agent referenced, if any. */
    referenced_ids: Type.Array(Type.String(), { maxItems: 5 }),
  }),
  model: "cheap",
  tools: [],
  quota: { maxTurns: 4 },
  memory: {
    enabled: true,
    includeIndex: true,
    writesPerTurn: 1,
  },
});

export const MEMORY_SELF_LEARN_SCENARIO = {
  id: "memory-self-learn",
  name: "Memory: surface a pre-seeded fact",
  category: "data" as const,
  description:
    "Seeds the in-memory adapter with one global fact ('drover uses TypeBox, not Zod'), " +
    "then asks the agent which schema library drover uses. Asserts the answer references " +
    "TypeBox and `used_memory: true`.",
  agent: memoryAgent,
  seed: {
    scope: "global" as const,
    kind: "reference" as const,
    summary: "drover uses TypeBox for all schemas",
    body: "Schema choice locked: tool I/O, agent specs, and MCP wire format all use TypeBox. Zod was rejected at design time.",
    tags: ["schema", "drover"],
  },
  question: "What schema library does drover use?",
};
