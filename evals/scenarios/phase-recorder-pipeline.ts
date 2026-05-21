import { Type } from "@sinclair/typebox";
import { defineAgent } from "@drover/core";
import { phaseRecorderPlugin } from "@drover/plugins";
import type { Scenario } from "./types.ts";

// A scenario where the agent walks through a 4-phase pipeline (plan →
// outline → draft → polish) and records each transition via the
// `record_phase` tool. The phaseRecorderPlugin captures the timeline;
// the runner persists it in result.json.

const recorder = phaseRecorderPlugin();

const spec = defineAgent({
  id: "pipeline-writer",
  systemPrompt: [
    "You write a short blog post in four phases. After completing each",
    "phase, call `record_phase` with the phase name + status='done'.",
    "Phases (in order): plan, outline, draft, polish.",
    "Stay terse — the post target is 80 words.",
    "Final output: {body, phases_marked}. phases_marked counts how many",
    "phases you signalled via record_phase.",
  ].join("\n"),
  inputSchema: Type.Object({ topic: Type.String() }),
  outputSchema: Type.Object({
    body: Type.String({ minLength: 50 }),
    phases_marked: Type.Integer({ minimum: 0, maximum: 10 }),
  }),
  model: "cheap",
  tools: [],
  plugins: [recorder.plugin],
  quota: { maxTurns: 6 },
});

export const scenario: Scenario<typeof spec> = {
  id: "phase-recorder-pipeline",
  name: "Multi-phase pipeline with timeline recording",
  category: "pipeline",
  description:
    "Agent walks plan → outline → draft → polish, marking each via record_phase. phaseRecorderPlugin captures the timeline.",
  spec,
  input: { topic: "the agent harness convergence trend" },
};

// Exposed for the runner so it can persist the recorded phases.
export { recorder };
