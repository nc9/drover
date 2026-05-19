/**
 * Per-run context threaded through the harness, plugins, and tools.
 *
 * `runId` is unique per top-level invocation. Child runs (spawned via
 * `taskTool`) get a suffix-derived id `<parent>:<n>` so they share a
 * trace ancestor while remaining individually queryable.
 */
export interface RunContext {
  runId: string;
  /** Set on subagent invocations; absent on top-level runs. */
  parentRunId?: string;
  /** Nesting depth from the root. Root = 0. */
  depth: number;
  /** Working directory for tools that touch the filesystem. */
  cwd: string;
  /** Environment exposed to sandbox/subprocess tools. */
  env: Readonly<Record<string, string>>;
  /** External cancellation. Honoured by the run loop and tools. */
  signal: AbortSignal;
  /**
   * Free-form metadata propagated through events. Useful for downstream
   * tagging (orgId, websiteId, jobId, etc.) without baking those into
   * drover's public surface.
   */
  meta?: Readonly<Record<string, unknown>>;
}
