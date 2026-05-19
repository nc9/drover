import { Type } from "@sinclair/typebox";
import { defineTool, type ToolDef } from "@drover/core";
import type { SandboxAdapter } from "@drover/sandbox";
import { Effect } from "effect";

const InputSchema = Type.Object({
  pattern: Type.String({ description: "Extended regex pattern" }),
  path: Type.Optional(Type.String({ description: "Search root (file or dir). Defaults to run cwd." })),
  glob: Type.Optional(Type.String({ description: "Optional file glob, e.g. '*.ts'" })),
  max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});

export function grepTool(sandbox: SandboxAdapter): ToolDef<typeof InputSchema> {
  return defineTool({
    id: "grep",
    description: "Recursive regex search. Returns up to max_results matching lines with file:line prefixes.",
    inputSchema: InputSchema,
    execute: (input, ctx) =>
      Effect.gen(function* () {
        const target = input.path ? sandbox.resolvePath(input.path, ctx.cwd) : ctx.cwd;
        // Gate the target path through the sandbox's allowed-roots check.
        // `sandbox.run` only checks cwd; without this an agent could pass
        // `path: "/etc"` and exfiltrate from outside the sandbox root.
        yield* sandbox.assertPathAllowed(target);
        const limit = input.max_results ?? 100;
        const args = ["-RInE", `--max-count=${limit}`];
        if (input.glob) args.push(`--include=${input.glob}`);
        args.push(input.pattern, target);
        const result = yield* sandbox.run("grep", args, { cwd: ctx.cwd, env: ctx.env, signal: ctx.signal });
        const content = result.stdout.length > 16384 ? result.stdout.slice(0, 16384) + "\n…[truncated]" : result.stdout;
        return {
          content: content || "(no matches)",
          isError: false,
          data: { exitCode: result.exitCode },
        };
      }),
  });
}
