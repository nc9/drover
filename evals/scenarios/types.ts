import type { AgentSpec, AgentInput } from "@droveragent/core";
import type { TSchema } from "@sinclair/typebox";

/** What every scenario file exports. */
export interface Scenario<S extends AgentSpec<TSchema, TSchema> = AgentSpec<TSchema, TSchema>> {
  /** Short id used for result directory naming. */
  id: string;
  /** Long-form name for the report header. */
  name: string;
  /** Broad bucket — used for grouping in reports. */
  category:
    | "policy"
    | "content"
    | "code"
    | "data"
    | "research"
    | "pipeline"
    | "mcp"
    | "queue"
    | "skills"
    | "generic";
  /** Single-sentence purpose for the report. */
  description: string;
  spec: S;
  input: AgentInput<S>;
  /**
   * Per-scenario fixture directory (under evals/fixtures/). The runner
   * snapshots this into a tmp dir per run so agents don't mutate the
   * canonical fixture. Absent for scenarios with no filesystem needs.
   */
  fixtureDir?: string;
}
