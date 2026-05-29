import { Type } from "@sinclair/typebox";
import { defineTool, type ToolDef } from "@droveragent/core";
import type { SandboxAdapter } from "@droveragent/sandbox";
import { Effect } from "effect";

const InputSchema = Type.Object({
  path: Type.String({ description: "File path. Relative paths resolve from the run cwd." }),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "1-based start line" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Max lines to return" })),
});

export function readTool(sandbox: SandboxAdapter): ToolDef<typeof InputSchema> {
  return defineTool({
    id: "read",
    description: "Read a file. Returns content with optional offset/limit windowing.",
    inputSchema: InputSchema,
    execute: (input, ctx) =>
      Effect.gen(function* () {
        const abs = sandbox.resolvePath(input.path, ctx.cwd);
        const text = yield* sandbox.readFile(abs);
        if (input.offset === undefined && input.limit === undefined) {
          return { content: text };
        }
        const lines = text.split("\n");
        const start = (input.offset ?? 1) - 1;
        const end = input.limit !== undefined ? start + input.limit : lines.length;
        return { content: lines.slice(start, end).join("\n") };
      }),
  });
}
