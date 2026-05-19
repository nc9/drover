import { SandboxError } from "@drover/core";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

import type { ExecOptions, ExecResult, SandboxAdapter } from "./adapter.ts";

export interface NoneSandboxOptions {
  /**
   * Roots the sandbox will read/write under. Any resolved absolute path
   * must lie inside at least one root. Use an empty array to allow any
   * path (NOT recommended outside trusted single-user contexts).
   */
  allowedRoots?: ReadonlyArray<string>;
  /**
   * Runner identifier used in errors. Defaults to "none". Override for
   * telemetry distinguishability when wiring multiple flavours.
   */
  id?: string;
  /**
   * Opt into shell execution despite the lack of OS-level isolation.
   * Required for the `bash` tool to be composed into a run. Default
   * `false` — the harness will skip `bash` if a spec requests it under
   * a sandbox without this flag. Set `true` only when you trust the
   * agent / prompt origin.
   */
  allowShell?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function ensureInsideRoots(
  abs: string,
  roots: ReadonlyArray<string>,
  op: "exec" | "read" | "write",
): SandboxError | null {
  if (roots.length === 0) return null;
  for (const root of roots) {
    const r = path.resolve(root) + path.sep;
    if ((abs + path.sep).startsWith(r)) return null;
  }
  return new SandboxError({
    runId: "(sandbox)",
    op,
    path: abs,
    message: `path escapes allowed roots [${roots.join(", ")}]`,
  });
}

/**
 * Resolve a path through any intervening symlinks. For a path that doesn't
 * exist (typical for `writeFile`), resolve the deepest existing ancestor
 * and re-attach the trailing component(s). Returns the OS-canonical path.
 */
async function realResolve(p: string): Promise<string> {
  const abs = path.resolve(p);
  try {
    return await fs.realpath(abs);
  } catch {
    // Walk up until we find an existing ancestor, then re-attach the tail.
    let cursor = abs;
    const tail: string[] = [];
    while (cursor !== path.dirname(cursor)) {
      const parent = path.dirname(cursor);
      try {
        const realParent = await fs.realpath(parent);
        return path.join(realParent, path.basename(cursor), ...tail.reverse());
      } catch {
        tail.push(path.basename(cursor));
        cursor = parent;
      }
    }
    return abs;
  }
}

/**
 * In-process sandbox. **NOT A SECURITY BOUNDARY.**
 *
 * What it does:
 *   - `readFile`/`writeFile` resolve the requested path (including any
 *     symlink, via `realpath`) and reject anything outside `allowedRoots`.
 *   - `run` (used by the `bash` tool) checks only the spawn `cwd` against
 *     `allowedRoots` — but the spawned process can read or write absolute
 *     paths anywhere the OS lets the user. The shell escape is by design;
 *     `bash` cannot be made safe without an OS-level isolation layer
 *     (seatbelt / docker / firejail / etc).
 *
 * Use this adapter for trusted runs, evals, and deployments that
 * already have isolation at a different layer. **If you compose `bash`
 * into an agent driven by untrusted prompts, you need a real sandbox,
 * not this one.**
 */
export function createNoneSandbox(opts: NoneSandboxOptions = {}): SandboxAdapter {
  // Canonicalise allowed roots at construction time. On macOS `/var` is a
  // symlink to `/private/var`, etc. — without this, every realpath check
  // on a tmp-rooted path would fail because the resolved real path no
  // longer prefixes the unresolved root.
  const rawRoots = (opts.allowedRoots ?? []).map((r) => path.resolve(r));
  const roots: string[] = rawRoots.map((r) => {
    try {
      return fsSync.realpathSync(r);
    } catch {
      return r;
    }
  });
  const id = opts.id ?? "none";

  const resolvePath = (p: string, cwd: string): string => {
    return path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
  };

  const run = (
    cmd: string,
    args: ReadonlyArray<string>,
    runOpts?: ExecOptions,
  ): Effect.Effect<ExecResult, SandboxError, never> =>
    Effect.tryPromise({
      try: async (): Promise<ExecResult> => {
        const cwd = await realResolve(runOpts?.cwd ?? process.cwd());
        const rootCheck = ensureInsideRoots(cwd, roots, "exec");
        if (rootCheck) throw rootCheck;

        const proc = Bun.spawn([cmd, ...args], {
          cwd,
          env: runOpts?.env ? { ...process.env, ...runOpts.env } : process.env,
          stdout: "pipe",
          stderr: "pipe",
        });

        const timeoutMs = runOpts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          proc.kill();
        }, timeoutMs);

        const onAbort = (): void => {
          killed = true;
          proc.kill();
        };
        runOpts?.signal?.addEventListener("abort", onAbort, { once: true });

        try {
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          return { exitCode, stdout, stderr, killed };
        } finally {
          clearTimeout(timer);
          runOpts?.signal?.removeEventListener("abort", onAbort);
        }
      },
      catch: (err): SandboxError =>
        err instanceof SandboxError
          ? err
          : new SandboxError({
              runId: "(sandbox)",
              op: "exec",
              message: (err as Error).message,
            }),
    });

  const readFile = (p: string): Effect.Effect<string, SandboxError, never> =>
    Effect.tryPromise({
      try: async (): Promise<string> => {
        const real = await realResolve(p);
        const rootCheck = ensureInsideRoots(real, roots, "read");
        if (rootCheck) throw rootCheck;
        return await fs.readFile(real, "utf8");
      },
      catch: (err): SandboxError =>
        err instanceof SandboxError
          ? err
          : new SandboxError({
              runId: "(sandbox)",
              op: "read",
              path: p,
              message: (err as Error).message,
            }),
    });

  const writeFile = (p: string, contents: string): Effect.Effect<void, SandboxError, never> =>
    Effect.tryPromise({
      try: async (): Promise<void> => {
        const real = await realResolve(p);
        const rootCheck = ensureInsideRoots(real, roots, "write");
        if (rootCheck) throw rootCheck;
        await fs.mkdir(path.dirname(real), { recursive: true });
        await fs.writeFile(real, contents, "utf8");
      },
      catch: (err): SandboxError =>
        err instanceof SandboxError
          ? err
          : new SandboxError({
              runId: "(sandbox)",
              op: "write",
              path: p,
              message: (err as Error).message,
            }),
    });

  const assertPathAllowed = (p: string): Effect.Effect<void, SandboxError, never> =>
    Effect.tryPromise({
      try: async (): Promise<void> => {
        const real = await realResolve(p);
        const rootCheck = ensureInsideRoots(real, roots, "read");
        if (rootCheck) throw rootCheck;
      },
      catch: (err): SandboxError =>
        err instanceof SandboxError
          ? err
          : new SandboxError({
              runId: "(sandbox)",
              op: "read",
              path: p,
              message: (err as Error).message,
            }),
    });

  return {
    id,
    capabilities: { shell: opts.allowShell === true },
    run,
    readFile,
    writeFile,
    resolvePath,
    assertPathAllowed,
  };
}
