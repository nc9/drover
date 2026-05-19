import type { AnyToolDef } from "@drover/core";
import type { SandboxAdapter } from "@drover/sandbox";

import { bashTool } from "./bash.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";
import { findTool } from "./find.ts";

export type BuiltinToolId = "bash" | "read" | "write" | "edit" | "grep" | "ls" | "find";

/**
 * Build all builtin tools wired against a sandbox. Agents pick a subset
 * by listing the ids in their `AgentSpec.tools`; the harness filters by
 * id when composing.
 */
export function buildBuiltins(sandbox: SandboxAdapter): ReadonlyArray<AnyToolDef> {
  return [
    bashTool(sandbox),
    readTool(sandbox),
    writeTool(sandbox),
    editTool(sandbox),
    grepTool(sandbox),
    lsTool(sandbox),
    findTool(sandbox),
  ];
}

/** Lookup helper for harness composition. */
export function builtinsById(sandbox: SandboxAdapter): Readonly<Record<BuiltinToolId, AnyToolDef>> {
  return {
    bash: bashTool(sandbox),
    read: readTool(sandbox),
    write: writeTool(sandbox),
    edit: editTool(sandbox),
    grep: grepTool(sandbox),
    ls: lsTool(sandbox),
    find: findTool(sandbox),
  };
}
