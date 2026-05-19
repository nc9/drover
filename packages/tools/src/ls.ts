import { Type } from "@sinclair/typebox";
import { defineTool, type ToolDef } from "@drover/core";
import type { SandboxAdapter } from "@drover/sandbox";
import { Effect } from "effect";

const InputSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory. Defaults to run cwd." })),
  all: Type.Optional(Type.Boolean({ description: "Include dotfiles" })),
});

export function lsTool(sandbox: SandboxAdapter): ToolDef<typeof InputSchema> {
  return defineTool({
    id: "ls",
    description: "List directory contents.",
    inputSchema: InputSchema,
    execute: (input, ctx) =>
      Effect.gen(function* () {
        const target = input.path ? sandbox.resolvePath(input.path, ctx.cwd) : ctx.cwd;
        yield* sandbox.assertPathAllowed(target);
        const args = input.all ? ["-la"] : ["-l"];
        args.push(target);
        const result = yield* sandbox.run("ls", args, { cwd: ctx.cwd, env: ctx.env, signal: ctx.signal });
        return {
          content: result.stdout || result.stderr || "(empty)",
          isError: result.exitCode !== 0,
        };
      }),
  });
}
