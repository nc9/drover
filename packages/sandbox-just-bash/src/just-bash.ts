import { SandboxError } from "@drover/core";
import type { ExecOptions, ExecResult, SandboxAdapter } from "@drover/sandbox";
import { Effect } from "effect";
import { Bash, InMemoryFs, MountableFs, OverlayFs, ReadWriteFs } from "just-bash";
import type {
  BashOptions,
  ExecOptions as JbExecOptions,
  InitialFiles,
  JavaScriptConfig,
  NetworkConfig,
} from "just-bash";
import * as posix from "node:path/posix";

/**
 * A docker-style bind mount: expose a host directory inside the sandbox.
 */
export interface JustBashMount {
  /** Host directory to expose. */
  source: string;
  /** Absolute path inside the sandbox to expose it at (cannot be `/`). */
  target: string;
  /**
   * `"readonly"` (default) — reads pass through, writes go to a discarded
   * copy-on-write layer; the host dir is never mutated. `"readwrite"` —
   * writes land on the host. Either way the agent cannot escape `source`
   * (no `..`, absolute, or symlink traversal out of the root).
   */
  mode?: "readonly" | "readwrite";
}

export interface JustBashSandboxOptions {
  /**
   * Docker-style mounts. Default `[]` — a fully in-memory sandbox with no
   * host filesystem access at all. The agent sees only what is mounted here
   * (plus anything in `files`).
   */
  mounts?: ReadonlyArray<JustBashMount>;
  /** Seed files for the in-memory base filesystem (path -> contents). */
  files?: InitialFiles;
  /** Base environment exposed inside the sandbox. */
  env?: Record<string, string>;
  /** Initial working directory inside the sandbox. Default just-bash's own. */
  cwd?: string;
  /**
   * Enable the `python3`/`python` commands (CPython compiled to WASM).
   * Off by default — extra security surface.
   */
  python?: boolean;
  /**
   * Enable the `js-exec` command (sandboxed JavaScript via QuickJS). Off by
   * default. Pass a config object to supply `bootstrap` code or an
   * `invokeTool` host callback.
   */
  javascript?: boolean | JavaScriptConfig;
  /**
   * Network access for `curl`/`wget`. Off by default — pass an allowlist to
   * enable specific URLs.
   */
  network?: NetworkConfig;
  /** Per-call default timeout, ms. Default 30_000 (matches the `none` adapter). */
  timeoutMs?: number;
  /** Telemetry identifier. Default `"just-bash"`. */
  id?: string;
}

// Standard directories recreated on the in-memory base. Deliberately omits
// `/bin` and `/usr/bin`: when a `bin` directory exists just-bash switches
// command resolution to a PATH lookup and stops finding its own builtins.
const STANDARD_DIRS = [
  "/tmp",
  "/home",
  "/home/user",
  "/root",
  "/dev",
  "/proc",
  "/etc",
  "/var",
  "/var/tmp",
  "/mnt",
  "/opt",
];

const DEFAULT_TIMEOUT_MS = 30_000;

const sandboxError = (op: "exec" | "read" | "write", err: unknown, path?: string): SandboxError =>
  err instanceof SandboxError
    ? err
    : new SandboxError({
        runId: "(sandbox)",
        op,
        ...(path !== undefined ? { path } : {}),
        message: err instanceof Error ? err.message : String(err),
      });

/**
 * just-bash virtual sandbox. **A real isolation boundary** — unlike `none`,
 * the agent reaches the host filesystem only through explicit {@link
 * JustBashMount}s, has no network unless one is configured, and runs under
 * execution limits. `bash` is therefore safe to compose by default
 * (`capabilities.shell` is unconditionally `true`).
 *
 * The whole sandbox is one `Bash` instance, so the virtual filesystem
 * persists across `run` / `readFile` / `writeFile`. Calls are serialised —
 * just-bash saves and restores shell state (cwd, env) around each run, which
 * interleaving concurrent calls would corrupt.
 */
export function createJustBashSandbox(opts: JustBashSandboxOptions = {}): SandboxAdapter {
  const id = opts.id ?? "just-bash";
  const defaultTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // A custom `fs` skips just-bash's own layout init, so recreate the
  // standard directory tree on the in-memory base — without it the default
  // cwd (/home/user) is missing and python / `cd` / temp-file writes fail.
  const base = new InMemoryFs(opts.files);
  for (const dir of STANDARD_DIRS) base.mkdirSync(dir, { recursive: true });
  const fs = new MountableFs({ base });
  for (const m of opts.mounts ?? []) {
    const child =
      (m.mode ?? "readonly") === "readwrite"
        ? new ReadWriteFs({ root: m.source })
        : // `mountPoint: "/"` — MountableFs hands the child paths already
          // relative to the mount point, so the overlay must treat its own
          // root as `/`.
          new OverlayFs({ root: m.source, readOnly: true, mountPoint: "/" });
    fs.mount(m.target, child);
  }

  const bashOpts: BashOptions = { fs };
  if (opts.env) bashOpts.env = opts.env;
  if (opts.cwd) bashOpts.cwd = opts.cwd;
  if (opts.python) bashOpts.python = true;
  if (opts.javascript !== undefined) bashOpts.javascript = opts.javascript;
  if (opts.network) bashOpts.network = opts.network;
  const bash = new Bash(bashOpts);

  // Serialise every operation: just-bash mutates and restores shell state
  // around each run, so concurrent calls would race. Cheap insurance —
  // drover defaults tool execution to sequential anyway.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn, fn);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const run = (
    cmd: string,
    args: ReadonlyArray<string>,
    runOpts?: ExecOptions,
  ): Effect.Effect<ExecResult, SandboxError, never> =>
    Effect.tryPromise({
      try: (): Promise<ExecResult> =>
        exclusive(async (): Promise<ExecResult> => {
          const timeoutMs = runOpts?.timeoutMs ?? defaultTimeout;
          const ac = new AbortController();
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            ac.abort();
          }, timeoutMs);
          const onAbort = (): void => ac.abort();
          if (runOpts?.signal?.aborted) ac.abort();
          else runOpts?.signal?.addEventListener("abort", onAbort, { once: true });

          try {
            const execOpts: JbExecOptions = { signal: ac.signal };
            if (runOpts?.cwd) execOpts.cwd = runOpts.cwd;
            if (runOpts?.env) execOpts.env = { ...runOpts.env };

            // The `bash` tool calls `run("/bin/sh", ["-c", <script>])` — hand
            // the script straight to the interpreter. Every other caller
            // (grep/find/ls tools) passes a bare command + argv, which the
            // `args` option forwards verbatim, bypassing shell parsing.
            const isShellC =
              (cmd === "/bin/sh" || cmd === "sh" || cmd === "/bin/bash" || cmd === "bash") &&
              args[0] === "-c";
            const result = isShellC
              ? await bash.exec(args[1] ?? "", execOpts)
              : await bash.exec(cmd, { ...execOpts, args: [...args] });

            const killed = timedOut || (runOpts?.signal?.aborted ?? false);
            return {
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              killed,
            };
          } finally {
            clearTimeout(timer);
            runOpts?.signal?.removeEventListener("abort", onAbort);
          }
        }),
      catch: (err): SandboxError => sandboxError("exec", err),
    });

  const readFile = (p: string): Effect.Effect<string, SandboxError, never> =>
    Effect.tryPromise({
      try: (): Promise<string> => exclusive(() => bash.readFile(p)),
      catch: (err): SandboxError => sandboxError("read", err, p),
    });

  const writeFile = (p: string, contents: string): Effect.Effect<void, SandboxError, never> =>
    Effect.tryPromise({
      try: (): Promise<void> => exclusive(() => bash.writeFile(p, contents)),
      catch: (err): SandboxError => sandboxError("write", err, p),
    });

  // Pure join in the virtual posix namespace — no host `realpath`.
  const resolvePath = (p: string, cwd: string): string =>
    posix.isAbsolute(p) ? posix.normalize(p) : posix.normalize(posix.join(cwd, p));

  // The mount namespace *is* the boundary: an unmounted path simply does not
  // exist, and a readonly mount rejects writes at the filesystem layer. There
  // is nothing outside the sandbox to escape to, so this always succeeds —
  // the structural difference from `none`, whose check guards the real host FS.
  const assertPathAllowed = (): Effect.Effect<void, SandboxError, never> => Effect.void;

  return {
    id,
    capabilities: { shell: true },
    run,
    readFile,
    writeFile,
    resolvePath,
    assertPathAllowed,
  };
}
