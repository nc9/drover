import { Type } from "@sinclair/typebox";
import { defineTool, type ToolDef } from "@droveragent/core";
import type { SandboxAdapter } from "@droveragent/sandbox";
import { Effect } from "effect";

const InputSchema = Type.Object({
  command: Type.String({ description: "Shell command to run via /bin/sh -c" }),
  cwd: Type.Optional(Type.String({ description: "Working directory; defaults to run cwd" })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 600_000 })),
});

/**
 * `bash` tool. Spawns `/bin/sh -c <command>` via the wired sandbox adapter.
 *
 * Security caveat: the `none` sandbox checks only `cwd` against
 * `allowedRoots` — once the shell runs, the agent can `cat /etc/passwd`,
 * `ls /`, or otherwise read/write absolute paths. Only compose `bash`
 * into agents you trust, or wire a real OS-level sandbox adapter
 * (seatbelt/docker/firejail/…). See `@droveragent/sandbox` README.
 */
export function bashTool(sandbox: SandboxAdapter): ToolDef<typeof InputSchema> {
  return defineTool({
    id: "bash",
    description: "Execute a shell command via /bin/sh -c. Output truncated to 16KB if longer.",
    inputSchema: InputSchema,
    destructive: true,
    timeoutMs: 60_000,
    execute: (input, ctx) =>
      Effect.gen(function* () {
        const result = yield* sandbox.run("/bin/sh", ["-c", input.command], {
          cwd: input.cwd ?? ctx.cwd,
          env: ctx.env,
          timeoutMs: input.timeout_ms ?? 60_000,
          signal: ctx.signal,
        });
        const combined = (result.stdout || "") + (result.stderr ? `\n[stderr]\n${result.stderr}` : "");
        const truncated = combined.length > 16384 ? combined.slice(0, 16384) + "\n…[truncated]" : combined;
        return {
          content: `exit=${result.exitCode}${result.killed ? " (killed)" : ""}\n${truncated}`,
          isError: result.exitCode !== 0,
          data: { exitCode: result.exitCode, killed: result.killed ?? false },
        };
      }),
  });
}
