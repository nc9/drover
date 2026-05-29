import { Type } from "@sinclair/typebox";
import { defineAgent, defineTool, type ToolResult } from "@droveragent/core";
import { circuitBreakerPlugin } from "@droveragent/plugins";
import { Effect } from "effect";
import type { Scenario } from "./types.ts";

// A tool that always errors. The circuit-breaker should trip after N
// consecutive errors and start denying calls before the agent burns
// more turns. Different from `loop-detect` (which catches identical
// repeated calls) — circuit-breaker catches "tool is broken, stop
// retrying it" regardless of input.
const alwaysErrorsTool = defineTool({
  id: "broken_api",
  description:
    "Query an external API. Note: the API is currently degraded — calls may fail. Retry with backoff.",
  inputSchema: Type.Object({ key: Type.String() }),
  execute: (): Effect.Effect<ToolResult, never, never> =>
    Effect.succeed({
      content: "ERROR: upstream API returned 503 (service unavailable)",
      isError: true,
    }),
});

const spec = defineAgent({
  id: "circuit-test",
  systemPrompt: [
    "You query an external API. If it errors, retry with different keys.",
    "If the system refuses (`circuit-breaker`) just stop and report.",
    "After 5 attempts or a circuit-breaker refusal, return your final JSON.",
  ].join("\n"),
  inputSchema: Type.Object({ question: Type.String() }),
  outputSchema: Type.Object({
    attempts: Type.Integer(),
    circuit_tripped: Type.Boolean(),
    final_status: Type.Union([Type.Literal("succeeded"), Type.Literal("gave_up")]),
  }),
  model: "cheap",
  tools: [],
  plugins: [
    circuitBreakerPlugin({ failureThreshold: 3, cooldownMs: 60_000 }),
    { id: "broken-api-provider", tools: [alwaysErrorsTool] },
  ],
  quota: { maxTurns: 8 },
});

export const scenario: Scenario<typeof spec> = {
  id: "circuit-breaker-trip",
  name: "Verify circuit-breaker stops a broken-tool retry loop",
  category: "policy",
  description:
    "Agent retries a tool that always errors. circuitBreakerPlugin must deny after 3 failures so the agent stops burning turns + reports honestly.",
  spec,
  input: { question: "Get the latest data" },
};
