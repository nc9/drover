import { Type } from "@sinclair/typebox";
import { defineTool, type ToolDef } from "@drover/core";
import type { SandboxAdapter } from "@drover/sandbox";
import { Effect } from "effect";

const InputSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Search root. Defaults to run cwd." })),
  name: Type.Optional(Type.String({ description: "Filename glob, e.g. '*.ts'" })),
  type: Type.Optional(Type.Union([Type.Literal("f"), Type.Literal("d")])),
  max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});

export function findTool(sandbox: SandboxAdapter): ToolDef<typeof InputSchema> {
  return defineTool({
    id: "find",
    description: "Locate files by name pattern.",
    inputSchema: InputSchema,
    execute: (input, ctx) =>
      Effect.gen(function* () {
        const target = input.path ? sandbox.resolvePath(input.path, ctx.cwd) : ctx.cwd;
        yield* sandbox.assertPathAllowed(target);
        const args = [target];
        if (input.max_depth !== undefined) args.push("-maxdepth", String(input.max_depth));
        if (input.type) args.push("-type", input.type);
        if (input.name) args.push("-name", input.name);
        const result = yield* sandbox.run("find", args, { cwd: ctx.cwd, env: ctx.env, signal: ctx.signal });
        const content = result.stdout.length > 16384 ? result.stdout.slice(0, 16384) + "\n…[truncated]" : result.stdout;
        return {
          content: content || "(no matches)",
          isError: result.exitCode !== 0,
        };
      }),
  });
}
