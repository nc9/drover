import { Type } from "@sinclair/typebox";
import { defineTool, type ToolDef } from "@droveragent/core";
import type { SandboxAdapter } from "@droveragent/sandbox";
import { Effect } from "effect";

const InputSchema = Type.Object({
  path: Type.String({ description: "File path. Parent directories are created." }),
  contents: Type.String({ description: "Full file contents to write" }),
});

export function writeTool(sandbox: SandboxAdapter): ToolDef<typeof InputSchema> {
  return defineTool({
    id: "write",
    description: "Write a file. Overwrites if exists. Creates parent dirs.",
    inputSchema: InputSchema,
    destructive: true,
    execute: (input, ctx) =>
      Effect.gen(function* () {
        const abs = sandbox.resolvePath(input.path, ctx.cwd);
        yield* sandbox.writeFile(abs, input.contents);
        return { content: `wrote ${input.contents.length} bytes to ${abs}` };
      }),
  });
}
