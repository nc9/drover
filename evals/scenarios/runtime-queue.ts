// This scenario doesn't fit the normal `runAgent` shape — it exercises
// the runtime layer (queue + worker pool + RunApi) by enqueuing the
// same simple agent 5 times with concurrency=3, then verifying every
// job reaches a terminal state in storage.
//
// Wired into the runner via a custom hook (see `evals/run.ts`) rather
// than the standard `Scenario` interface, because the standard runner
// path runs a single `runAgent` per scenario.

import { Type } from "@sinclair/typebox";
import { defineAgent } from "@drover/core";

export const runtimeAgent = defineAgent({
  id: "runtime-echo",
  systemPrompt:
    "Reply with a JSON object echoing your input value as `received` and adding `ok: true`. No prose.",
  inputSchema: Type.Object({ n: Type.Integer() }),
  outputSchema: Type.Object({
    received: Type.Integer(),
    ok: Type.Boolean(),
  }),
  model: "cheap",
  tools: [],
  maxTurns: 2,
});

export const RUNTIME_QUEUE_SCENARIO = {
  id: "runtime-queue",
  name: "Runtime: enqueue 5 jobs, concurrency 3",
  category: "queue" as const,
  description:
    "Spawns a worker pool with concurrency=3 against an in-memory queue. Enqueues 5 echo jobs. Verifies every job lands in queue.status='done' and produces a valid output. Tests queue + pool + API + storage round-trip together.",
  agent: runtimeAgent,
  jobCount: 5,
  concurrency: 3,
};
