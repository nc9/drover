import { SandboxError } from "@droveragent/core";
import type { ExecOptions, ExecResult, SandboxAdapter } from "@droveragent/sandbox";
import type { NetworkPolicy } from "@vercel/sandbox";
import { Sandbox } from "@vercel/sandbox";
import { Effect } from "effect";
import * as posix from "node:path/posix";

/**
 * Structural slice of `@vercel/sandbox`'s `CommandFinished` the adapter
 * consumes. Tests implement these interfaces directly instead of mocking
 * the SDK module.
 */
export interface VercelFinishedCommand {
  exitCode: number;
  stdout(): Promise<string>;
  stderr(): Promise<string>;
}

/** Structural slice of a detached `Command`. */
export interface VercelCommandHandle {
  wait(params?: { signal?: AbortSignal }): Promise<VercelFinishedCommand>;
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}

/** Structural slice of `sandbox.fs` (node:fs/promises-compatible). */
export interface VercelFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

/** Parameters the adapter passes to `runCommand` (always detached). */
export interface VercelRunCommandParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  detached: true;
  /** Sandbox-side backstop; the adapter's own deadline is the primary. */
  timeoutMs?: number;
}

/** Structural slice of a `Sandbox` instance. */
export interface VercelSandboxHandle {
  runCommand(params: VercelRunCommandParams): Promise<VercelCommandHandle>;
  readonly fs: VercelFs;
  stop(opts?: { signal?: AbortSignal }): Promise<unknown>;
}

/** Parameters forwarded to `Sandbox.getOrCreate`. */
export interface VercelAcquireParams {
  name?: string;
  source?: { type: "snapshot"; snapshotId: string };
  runtime?: string;
  networkPolicy: NetworkPolicy;
  timeout?: number;
  resources?: { vcpus: number };
  persistent?: boolean;
  snapshotExpiration?: number;
  keepLastSnapshots?: { count: number; expiration?: number; deleteEvicted?: boolean };
  env?: Record<string, string>;
  onCreate?: (sandbox: VercelSandboxHandle) => Promise<void>;
  onResume?: (sandbox: VercelSandboxHandle) => Promise<void>;
}

/** Structural slice of the `Sandbox` static side — injectable for tests. */
export interface VercelSandboxClient {
  getOrCreate(params: VercelAcquireParams): Promise<VercelSandboxHandle>;
}

export interface VercelSandboxOptions {
  /**
   * Sandbox name for `Sandbox.getOrCreate` — the same name resumes the
   * same (persistent) sandbox across sessions. Random when omitted.
   */
  name?: string;
  /** Seed a freshly created sandbox from an existing snapshot. Wins over `runtime`. */
  snapshotId?: string;
  /** Runtime image, e.g. `"node24"` (SDK default) or `"python3.13"`. */
  runtime?: string;
  /**
   * Egress firewall. Defaults to `"deny-all"` — the SDK's own default is
   * `"allow-all"`, but drover sandboxes ship locked down (just-bash has no
   * network unless configured either). Pass `"allow-all"` or a domain
   * allowlist to open egress.
   */
  networkPolicy?: NetworkPolicy;
  /** VM session timeout in ms (SDK default 5 min). Sessions auto-stop at expiry. */
  timeout?: number;
  /** vCPUs for the VM (2048 MB RAM per vCPU; SDK default 2). */
  resources?: { vcpus: number };
  /** Auto-snapshot the filesystem on stop and restore on resume. SDK default true. */
  persistent?: boolean;
  /** Default snapshot TTL in ms. SDK default 30 days; `0` = no expiration. */
  snapshotExpiration?: number;
  /** Keep only the N most recent snapshots (`count` 1-10). */
  keepLastSnapshots?: { count: number; expiration?: number; deleteEvicted?: boolean };
  /** Default environment variables for every command in the sandbox. */
  env?: Record<string, string>;
  /** One-time setup when the sandbox is freshly created (seed files, installs). */
  onCreate?: (sandbox: VercelSandboxHandle) => Promise<void>;
  /** Runs on every session resume (restart daemons, re-warm caches). */
  onResume?: (sandbox: VercelSandboxHandle) => Promise<void>;
  /** Per-call default exec timeout, ms. Default 30_000 (matches just-bash). */
  timeoutMs?: number;
  /**
   * Tail cap per output stream, in bytes. Default 16 KiB. Longer output is
   * truncated to its tail with a note, so a runaway `cat` cannot blow the
   * transcript.
   */
  maxOutputBytes?: number;
  /** How long to wait after SIGKILL for exit code + output harvest, ms. Default 2_000. */
  killGraceMs?: number;
  /** Telemetry identifier. Default `"vercel-sandbox"`. */
  id?: string;
  /** SDK entry point — injectable for tests. Default: the real `Sandbox` class. */
  client?: VercelSandboxClient;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;
// The sandbox-side timeoutMs backstop trails the adapter's own deadline so
// the client-side race decides `killed` in the normal case.
const SDK_TIMEOUT_PAD_MS = 500;

// The real Sandbox class satisfies the structural client at runtime; its
// declared param/return types are wider (unions, overloads), so bridge with
// a single cast at this boundary.
const defaultClient: VercelSandboxClient = Sandbox as unknown as VercelSandboxClient;

const sandboxError = (op: "exec" | "read" | "write", err: unknown, path?: string): SandboxError =>
  err instanceof SandboxError
    ? err
    : new SandboxError({
        runId: "(sandbox)",
        op,
        ...(path !== undefined ? { path } : {}),
        message: err instanceof Error ? err.message : String(err),
      });

interface Deadline {
  promise: Promise<{ kind: "timeout" }>;
  clear: () => void;
}

const startDeadline = (ms: number): Deadline => {
  let timer!: ReturnType<typeof setTimeout>;
  const promise = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
};

interface AbortWatch {
  promise: Promise<{ kind: "abort" }>;
  cleanup: () => void;
}

const watchAbort = (signal: AbortSignal | undefined): AbortWatch => {
  let cleanup = (): void => {};
  const promise = new Promise<{ kind: "abort" }>((resolve) => {
    if (!signal) return; // never resolves; the deadline branch always does
    if (signal.aborted) {
      resolve({ kind: "abort" });
      return;
    }
    const onAbort = (): void => resolve({ kind: "abort" });
    signal.addEventListener("abort", onAbort, { once: true });
    cleanup = (): void => signal.removeEventListener("abort", onAbort);
  });
  return { promise, cleanup };
};

/**
 * Vercel Sandbox adapter: every op runs in a Firecracker microVM. **A real
 * isolation boundary** — the VM is remote, egress defaults to `deny-all`,
 * and nothing in the host filesystem is reachable, so `bash` is safe to
 * compose by default (`capabilities.shell` is unconditionally `true`).
 *
 * The VM is acquired lazily via `Sandbox.getOrCreate` on the first
 * operation. Persistent sandboxes (the SDK default) auto-snapshot their
 * filesystem on {@link VercelSandboxAdapter.stop} and restore it on the next
 * acquire, so files survive between sessions under a stable `name`.
 *
 * `run` enforces `timeoutMs`/`signal` with its own client-side race —
 * drover's `ToolDef.timeoutMs` is otherwise unenforced — and SIGKILLs the
 * remote process on expiry, resolving with `killed: true` (matching
 * just-bash) rather than failing, so the tool layer can report the partial
 * result. `SandboxError` is reserved for SDK/transport failures, including
 * failure to acquire the VM within the deadline.
 *
 * `readFile`/`writeFile`/`readdir` have no timeout parameter by contract;
 * wrap them with `Effect.timeout` if the call site needs a budget.
 *
 * Auth comes from the environment (`VERCEL_OIDC_TOKEN`, or
 * `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`) — see the Vercel
 * Sandbox authentication docs.
 */
export interface VercelSandboxAdapter extends SandboxAdapter {
  /** List directory entry names inside the VM (always implemented here). */
  readdir(path: string): Effect.Effect<ReadonlyArray<string>, SandboxError, never>;
  /**
   * Stop the VM session. Persistent sandboxes snapshot their filesystem
   * during stop; the next operation re-acquires (and restores) the sandbox.
   * A no-op when nothing was ever acquired. Safe to call repeatedly.
   */
  stop(): Effect.Effect<void, SandboxError, never>;
}

export function createVercelSandbox(opts: VercelSandboxOptions = {}): VercelSandboxAdapter {
  const id = opts.id ?? "vercel-sandbox";
  const client = opts.client ?? defaultClient;
  const defaultTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  const acquireParams: VercelAcquireParams = {
    networkPolicy: opts.networkPolicy ?? "deny-all",
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    // The SDK forbids `runtime` alongside a snapshot source.
    ...(opts.snapshotId !== undefined
      ? { source: { type: "snapshot", snapshotId: opts.snapshotId } }
      : opts.runtime !== undefined
        ? { runtime: opts.runtime }
        : {}),
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    ...(opts.resources !== undefined ? { resources: opts.resources } : {}),
    ...(opts.persistent !== undefined ? { persistent: opts.persistent } : {}),
    ...(opts.snapshotExpiration !== undefined
      ? { snapshotExpiration: opts.snapshotExpiration }
      : {}),
    ...(opts.keepLastSnapshots !== undefined ? { keepLastSnapshots: opts.keepLastSnapshots } : {}),
    ...(opts.env !== undefined ? { env: { ...opts.env } } : {}),
    ...(opts.onCreate !== undefined ? { onCreate: opts.onCreate } : {}),
    ...(opts.onResume !== undefined ? { onResume: opts.onResume } : {}),
  };

  // Lazy, memoised acquisition. Concurrent first ops share one in-flight
  // getOrCreate; a failed acquire resets so the next op can retry.
  let sandboxP: Promise<VercelSandboxHandle> | null = null;
  const acquire = (): Promise<VercelSandboxHandle> => {
    sandboxP ??= client.getOrCreate(acquireParams).catch((err: unknown) => {
      sandboxP = null;
      throw err;
    });
    return sandboxP;
  };

  const capTail = (text: string): string => {
    const total = Buffer.byteLength(text, "utf8");
    if (total <= maxOutputBytes) return text;
    const tail = Buffer.from(text, "utf8")
      .subarray(total - maxOutputBytes)
      .toString("utf8")
      // drop the partial code point a byte-boundary slice can leave behind
      .replace(/^�+/, "");
    return `[truncated: showing last ${maxOutputBytes} of ${total} bytes]\n${tail}`;
  };

  const collectOutput = async (finished: VercelFinishedCommand): Promise<[string, string]> => {
    const [stdout, stderr] = await Promise.all([
      finished.stdout().catch((err: unknown) => `[failed to collect stdout: ${String(err)}]`),
      finished.stderr().catch((err: unknown) => `[failed to collect stderr: ${String(err)}]`),
    ]);
    return [capTail(stdout), capTail(stderr)];
  };

  const interruptedResult = (
    kind: "timeout" | "abort",
    timeoutMs: number,
    stdout: string,
    stderr: string,
    exitCode = -1,
  ): ExecResult => {
    const note =
      kind === "timeout"
        ? `[command timed out after ${timeoutMs}ms and was killed]`
        : "[command aborted and was killed]";
    const capped = capTail(stderr);
    return {
      exitCode,
      stdout: capTail(stdout),
      stderr: capped === "" ? note : `${capped}\n${note}`,
      killed: true,
    };
  };

  const execRun = async (
    cmd: string,
    args: ReadonlyArray<string>,
    runOpts?: ExecOptions,
  ): Promise<ExecResult> => {
    const timeoutMs = runOpts?.timeoutMs ?? defaultTimeout;
    // Already-aborted: report killed without ever touching the VM
    // (matches just-bash).
    if (runOpts?.signal?.aborted) return interruptedResult("abort", timeoutMs, "", "");
    const deadline = startDeadline(timeoutMs);
    const abort = watchAbort(runOpts?.signal);
    try {
      // Acquisition counts against the exec deadline — a hung getOrCreate
      // must not hang the tool call. No process exists yet, so an expiry
      // here is an infra failure (SandboxError), not a killed result.
      const acquireP = acquire().then(
        (sandbox) => ({ kind: "acquired" as const, sandbox }),
        (error: unknown) => ({ kind: "acquire-error" as const, error }),
      );
      const acquired = await Promise.race([acquireP, deadline.promise, abort.promise]);
      if (acquired.kind === "acquire-error") throw acquired.error;
      if (acquired.kind !== "acquired") {
        throw new SandboxError({
          runId: "(sandbox)",
          op: "exec",
          message:
            acquired.kind === "timeout"
              ? `sandbox acquisition timed out after ${timeoutMs}ms`
              : "sandbox acquisition aborted",
        });
      }

      // Detached start so expiry can SIGKILL the remote process — aborting
      // only the client-side wait would leave it burning VM CPU.
      const startP = acquired.sandbox
        .runCommand({
          cmd,
          args: [...args],
          detached: true,
          timeoutMs: timeoutMs + SDK_TIMEOUT_PAD_MS,
          ...(runOpts?.cwd !== undefined ? { cwd: runOpts.cwd } : {}),
          ...(runOpts?.env !== undefined ? { env: { ...runOpts.env } } : {}),
        })
        .then(
          (command) => ({ kind: "started" as const, command }),
          (error: unknown) => ({ kind: "start-error" as const, error }),
        );
      const started = await Promise.race([startP, deadline.promise, abort.promise]);
      if (started.kind === "start-error") throw started.error;
      if (started.kind !== "started") {
        // Reap the orphan if the start ever completes.
        void startP.then((s) => {
          if (s.kind === "started") void s.command.kill("SIGKILL").catch(() => {});
        });
        return interruptedResult(started.kind, timeoutMs, "", "");
      }

      const waitP = started.command.wait().then(
        (finished) => ({ kind: "finished" as const, finished }),
        (error: unknown) => ({ kind: "wait-error" as const, error }),
      );
      const first = await Promise.race([waitP, deadline.promise, abort.promise]);
      if (first.kind === "wait-error") throw first.error;
      if (first.kind === "finished") {
        const [stdout, stderr] = await collectOutput(first.finished);
        return { exitCode: first.finished.exitCode, stdout, stderr, killed: false };
      }

      // Deadline or abort: kill, then a bounded grace to harvest the exit
      // code and any partial output.
      await started.command.kill("SIGKILL").catch(() => {});
      const grace = startDeadline(killGraceMs);
      const graced = await Promise.race([waitP, grace.promise]);
      grace.clear();
      if (graced.kind === "finished") {
        const [stdout, stderr] = await Promise.all([
          graced.finished.stdout().catch(() => ""),
          graced.finished.stderr().catch(() => ""),
        ]);
        return interruptedResult(first.kind, timeoutMs, stdout, stderr, graced.finished.exitCode);
      }
      return interruptedResult(first.kind, timeoutMs, "", "");
    } finally {
      deadline.clear();
      abort.cleanup();
    }
  };

  const run = (
    cmd: string,
    args: ReadonlyArray<string>,
    runOpts?: ExecOptions,
  ): Effect.Effect<ExecResult, SandboxError, never> =>
    Effect.tryPromise({
      try: (): Promise<ExecResult> => execRun(cmd, args, runOpts),
      catch: (err): SandboxError => sandboxError("exec", err),
    });

  const readFile = (p: string): Effect.Effect<string, SandboxError, never> =>
    Effect.tryPromise({
      try: async (): Promise<string> => {
        const sandbox = await acquire();
        return await sandbox.fs.readFile(p, "utf8");
      },
      catch: (err): SandboxError => sandboxError("read", err, p),
    });

  const writeFile = (p: string, contents: string): Effect.Effect<void, SandboxError, never> =>
    Effect.tryPromise({
      try: async (): Promise<void> => {
        const sandbox = await acquire();
        await sandbox.fs.writeFile(p, contents);
      },
      catch: (err): SandboxError => sandboxError("write", err, p),
    });

  const readdir = (p: string): Effect.Effect<ReadonlyArray<string>, SandboxError, never> =>
    Effect.tryPromise({
      try: async (): Promise<ReadonlyArray<string>> => {
        const sandbox = await acquire();
        return await sandbox.fs.readdir(p);
      },
      catch: (err): SandboxError => sandboxError("read", err, p),
    });

  // Pure join in the VM's posix namespace — no host `realpath`.
  const resolvePath = (p: string, cwd: string): string =>
    posix.isAbsolute(p) ? posix.normalize(p) : posix.normalize(posix.join(cwd, p));

  // The VM *is* the boundary: every path inside it is fair game, and there
  // is nothing of the host's to escape to — same structural argument as
  // just-bash's mount namespace. Always succeeds; API contract kept so
  // tools can call it uniformly.
  const assertPathAllowed = (): Effect.Effect<void, SandboxError, never> => Effect.void;

  const stop = (): Effect.Effect<void, SandboxError, never> =>
    Effect.tryPromise({
      try: async (): Promise<void> => {
        const pending = sandboxP;
        if (!pending) return;
        // Reset first: the next op re-acquires (and resumes from the
        // snapshot the stop is about to take).
        sandboxP = null;
        const sandbox = await pending.catch(() => null);
        if (sandbox) await sandbox.stop();
      },
      catch: (err): SandboxError => sandboxError("exec", err),
    });

  return {
    id,
    capabilities: { shell: true },
    run,
    readFile,
    writeFile,
    readdir,
    resolvePath,
    assertPathAllowed,
    stop,
  };
}
