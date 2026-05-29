import { Type } from "@sinclair/typebox";
import { defineTool, SandboxError, type ToolDef } from "@droveragent/core";
import type { SandboxAdapter } from "@droveragent/sandbox";
import { Effect } from "effect";

const InputSchema = Type.Object({
  path: Type.String(),
  old_string: Type.String({ description: "Exact text to replace (must be unique in file)" }),
  new_string: Type.String({ description: "Replacement text" }),
});

export function editTool(sandbox: SandboxAdapter): ToolDef<typeof InputSchema> {
  return defineTool({
    id: "edit",
    description: "Replace an exact string in a file. Errors if `old_string` is missing or not unique.",
    inputSchema: InputSchema,
    destructive: true,
    execute: (input, ctx) =>
      Effect.gen(function* () {
        const abs = sandbox.resolvePath(input.path, ctx.cwd);
        const text = yield* sandbox.readFile(abs);
        const firstIdx = text.indexOf(input.old_string);
        if (firstIdx === -1) {
          return yield* Effect.fail(
            new SandboxError({
              runId: ctx.runId,
              op: "write",
              path: abs,
              message: `old_string not found in ${abs}`,
            }),
          );
        }
        const lastIdx = text.lastIndexOf(input.old_string);
        if (lastIdx !== firstIdx) {
          return yield* Effect.fail(
            new SandboxError({
              runId: ctx.runId,
              op: "write",
              path: abs,
              message: `old_string is not unique in ${abs} — narrow it`,
            }),
          );
        }
        const next = text.slice(0, firstIdx) + input.new_string + text.slice(firstIdx + input.old_string.length);
        yield* sandbox.writeFile(abs, next);
        return { content: `edited ${abs} (replaced ${input.old_string.length} → ${input.new_string.length} bytes)` };
      }),
  });
}
