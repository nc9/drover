import type { Static, TSchema } from "@sinclair/typebox";
import type { Effect } from "effect";

import type { RunContext } from "./context.ts";
import type { ToolResult } from "./events.ts";
import type { SandboxError } from "./errors.ts";

/**
 * Definition-time tool record. TypeBox schema captured once; `execute`
 * receives statically-typed input inferred from the schema.
 *
 * Built-in tools (bash, read, write, …) and MCP-derived tools are both
 * normalised to this shape before the harness composes the toolset.
 */
export interface ToolDef<S extends TSchema = TSchema> {
  id: string;
  description: string;
  inputSchema: S;
  /**
   * Whether the tool mutates state. Used by plugins like confirm-gate
   * to decide whether a confirmation prompt is required.
   */
  destructive?: boolean;
  /** Per-tool timeout in milliseconds. */
  timeoutMs?: number;
  execute: (
    input: Static<S>,
    ctx: ToolExecutionContext,
  ) => Effect.Effect<ToolResult, SandboxError, never>;
}

/**
 * Erased tool shape the harness consumes. The schema lives at runtime
 * for decode; the static input type collapses to `never` on the call
 * site so any concrete `ToolDef<S>` assigns into this slot (covariant
 * collection of heterogeneous tools).
 *
 * Inside the harness, the schema is used to decode raw input into the
 * concrete static type before `execute` runs.
 */
export interface AnyToolDef {
  id: string;
  description: string;
  inputSchema: TSchema;
  destructive?: boolean;
  timeoutMs?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: any, ctx: ToolExecutionContext) => Effect.Effect<ToolResult, SandboxError, never>;
}

/**
 * What a tool sees when invoked. Strict subset of `RunContext` plus
 * the originating `toolUseId` (for plugins that correlate before/after).
 */
export interface ToolExecutionContext {
  runId: string;
  toolUseId: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  /** Bubble-up reference to the full run context for plugins that need it. */
  run: RunContext;
}

/**
 * Identity builder so callers get static input typing without
 * threading generics manually.
 */
export function defineTool<S extends TSchema>(tool: ToolDef<S>): ToolDef<S> {
  return tool;
}
