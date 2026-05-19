import { SandboxError } from "@drover/core";
import type { Effect } from "effect";

export interface ExecOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  /** Per-call timeout. Adapters MUST honour this and surface as SandboxError. */
  timeoutMs?: number;
  /** Cancellation. */
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the process was killed by signal or timeout. */
  killed?: boolean;
}

/**
 * Capabilities the harness consults before composing tools. The `shell`
 * capability is the load-bearing one — drover refuses to auto-inject the
 * `bash` tool into a run unless the sandbox advertises shell support, so
 * a tool-bearing agent can never silently get unsandboxed shell access.
 *
 * Sandbox impls that DO provide OS-level isolation (seatbelt, docker,
 * firejail, …) should set `shell: true`. The default `none` adapter has
 * `shell: false` unless the caller passes `{ allowShell: true }` to opt
 * into the documented escape — a deliberate "you said you trust this".
 */
export interface SandboxCapabilities {
  readonly shell: boolean;
}

/**
 * Transport-agnostic interface every sandbox impl satisfies. Heavier
 * sandboxes (seatbelt, docker, daytona, CF container) live in their
 * consuming projects; drover ships only `none` and (later) `process`.
 *
 * All ops return Effect-typed values so callers can compose with the
 * harness's retry / timeout policies uniformly.
 */
export interface SandboxAdapter {
  /** Identifier for telemetry — e.g. "none", "process", "seatbelt". */
  readonly id: string;
  /** What the sandbox is willing to let through. */
  readonly capabilities: SandboxCapabilities;
  run(
    cmd: string,
    args: ReadonlyArray<string>,
    opts?: ExecOptions,
  ): Effect.Effect<ExecResult, SandboxError, never>;
  readFile(path: string): Effect.Effect<string, SandboxError, never>;
  writeFile(path: string, contents: string): Effect.Effect<void, SandboxError, never>;
  /**
   * Map a tool-supplied (possibly relative) path to a host-absolute path
   * within the run's working tree. The returned path may still escape
   * allowed roots — callers that intend to act on the path should pass
   * it through `assertPathAllowed` before doing so.
   */
  resolvePath(path: string, cwd: string): string;
  /**
   * Validate that a target path is within the sandbox's allowed roots
   * (after symlink resolution). Used by tools that pass user-supplied
   * paths to spawned processes — `grep`, `find`, `ls` — to prevent
   * escape via absolute paths or `..` traversal.
   *
   * `readFile` / `writeFile` already perform this check internally;
   * `run` cannot, because the spawned process's argv is opaque (the
   * `bash` tool is the canonical example of why it has to opt in via
   * `capabilities.shell` instead).
   */
  assertPathAllowed(path: string): Effect.Effect<void, SandboxError, never>;
}

export { SandboxError };
