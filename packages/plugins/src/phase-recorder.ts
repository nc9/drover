import { Type } from "@sinclair/typebox";
import { defineTool, type HarnessPlugin } from "@droveragent/core";
import { Effect } from "effect";

/**
 * Recorded phase transition — renderable as a timeline.
 */
export interface PhaseRecord {
  ts: number;
  name: string;
  /** Optional status: pending/running/done/failed/skipped. */
  status?: "pending" | "running" | "done" | "failed" | "skipped";
  detail?: string;
}

export interface PhaseRecorder {
  phases: ReadonlyArray<PhaseRecord>;
  plugin: HarnessPlugin;
}

const RecordPhaseInput = Type.Object({
  name: Type.String({
    description: "Phase id — short, stable token used by downstream dashboards.",
  }),
  status: Type.Optional(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("running"),
      Type.Literal("done"),
      Type.Literal("failed"),
      Type.Literal("skipped"),
    ]),
  ),
  detail: Type.Optional(Type.String({ maxLength: 500 })),
});

/**
 * Adds a `record_phase` tool the agent can call to mark progress through
 * a multi-stage pipeline (e.g. research → draft → polish → publish).
 * The accumulated `phases` array is exposed for storage + UI rendering
 * after the run.
 *
 * Use this when you want the timeline visible to ops without forcing the
 * model to emit special markers in its prose.
 */
export function phaseRecorderPlugin(): PhaseRecorder {
  const phases: PhaseRecord[] = [];

  const recordPhase = defineTool({
    id: "record_phase",
    description:
      "Mark a phase transition in your work (e.g. 'research-start', 'draft-done'). Use this so observability tools can render a timeline.",
    inputSchema: RecordPhaseInput,
    execute: (input) =>
      Effect.sync(() => {
        const rec: PhaseRecord = { ts: Date.now(), name: input.name };
        if (input.status) rec.status = input.status;
        if (input.detail) rec.detail = input.detail;
        phases.push(rec);
        return {
          content: `phase recorded: ${input.name}${input.status ? ` (${input.status})` : ""}`,
        };
      }),
  });

  const plugin: HarnessPlugin = {
    id: "phase-recorder",
    tools: [recordPhase],
  };

  return { phases, plugin };
}
