import { SandboxError } from "@droveragent/core";
import type { ExecOptions, ExecResult, SandboxAdapter } from "@droveragent/sandbox";
import { Effect } from "effect";

/**
 * Egress posture for the container.
 *
 * Unlike Vercel Sandbox — where the firewall is a `getOrCreate` parameter —
 * Cloudflare's egress controls live on the `Sandbox` **Durable Object**
 * (`@cloudflare/containers`' `enableInternet` field plus the runtime
 * `setAllowedHosts` / `setDeniedHosts` RPCs). Three consequences:
 *
 * 1. `deny-all` is only *real* when the DO subclass declares
 *    `enableInternet = false`. The adapter cannot read that flag over RPC,
 *    so it cannot verify it — see {@link CloudflareSandboxOptions.networkPolicy}.
 * 2. `allow-all` is likewise not something the adapter can switch on; it
 *    means "the adapter installs no host lists, the DO's own posture wins".
 * 3. Installing either list flips the container into **intercept-all** mode
 *    for the rest of its life (`@cloudflare/containers` promotes as soon as
 *    the outbound config is mutated at runtime). Any catch-all `static
 *    outbound` handler on the DO then sees *every* allowed host, not just
 *    the one it was written for — so a credential-stamping handler must key
 *    off `new URL(request.url).hostname` (or live in `static outboundByHost`)
 *    rather than assume its target.
 *
 * Host patterns are matched by `@cloudflare/containers`' `simpleGlobMatch`:
 * plain equality plus `*` wildcards, against the hostname only. As of
 * `@cloudflare/containers@0.3.7` there is **no CIDR matching** despite what
 * the docs suggest — a `"10.0.0.0/8"` entry matches nothing.
 */
export type CloudflareNetworkPolicy =
  | "deny-all"
  | "allow-all"
  | {
      /** Hostnames granted egress even when `enableInternet` is false. */
      allow: readonly string[];
      /** Hostnames blocked unconditionally, even when `enableInternet` is true. */
      deny?: readonly string[];
    };

/*
 * The structural slices below mirror `@cloudflare/sandbox` without importing
 * it — the SDK only loads inside `workerd`, so a direct import would make this
 * package untestable in plain bun and drag Workers types into every consumer.
 *
 * Verified byte-for-byte assignable against `@cloudflare/sandbox@0.13.0-next.751.1`
 * (`@cloudflare/containers@0.3.7`): the real `SandboxClient<Sandbox>` returned by
 * `getSandbox` satisfies `CloudflareSandboxHandle`, and `SandboxOptions` and
 * `CloudflareGetSandboxOptions` are mutually assignable. Re-run that check after
 * bumping the SDK — the prerelease line moves.
 */

/** Structural slice of the SDK's `ProcessOutput<string>`. */
export interface CloudflareProcessOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: number;
  /** True when the container-side `ExecOptions.timeout` fired. */
  timedOut: boolean;
  /** True when `maxBytes` clipped the captured streams. */
  truncated: boolean;
}

/** Structural slice of the SDK's `SandboxProcess`. */
export interface CloudflareProcessHandle {
  readonly id: string;
  output(options: {
    encoding: "utf8";
    maxBytes?: number;
    timeout?: number;
  }): Promise<CloudflareProcessOutput>;
  /** POSIX signal *number* — 9 for SIGKILL. (The SDK takes no string form.) */
  kill(signal?: number): Promise<void>;
}

/** Structural slice of the SDK's `ExecOptions`. Note: no `signal`. */
export interface CloudflareExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Container-side kill deadline, ms. */
  timeout?: number;
}

export interface CloudflareReadFileResult {
  success: boolean;
  content: string;
}

export interface CloudflareWriteFileResult {
  success: boolean;
}

export interface CloudflareMkdirResult {
  success: boolean;
}

export interface CloudflareFileInfo {
  name: string;
}

export interface CloudflareListFilesResult {
  success: boolean;
  files: CloudflareFileInfo[];
}

/**
 * Structural slice of `SandboxClient<Sandbox>` — the stub `getSandbox()`
 * returns. The optional members come from the `Container` base class rather
 * than `ISandbox`; a real client has them, a hand-rolled test double need
 * not (except where {@link CloudflareSandboxOptions.networkPolicy} requires
 * the egress controls — see `createCloudflareSandbox`).
 */
export interface CloudflareSandboxHandle {
  exec(
    command: readonly [string, ...string[]],
    options?: CloudflareExecOptions,
  ): Promise<CloudflareProcessHandle>;
  readFile(
    path: string,
    options?: { encoding?: "utf-8" | "utf8" | "base64" },
  ): Promise<CloudflareReadFileResult>;
  writeFile(
    path: string,
    content: string,
    options?: { encoding?: string },
  ): Promise<CloudflareWriteFileResult>;
  listFiles(
    path: string,
    options?: { recursive?: boolean; includeHidden?: boolean },
  ): Promise<CloudflareListFilesResult>;
  mkdir?(path: string, options?: { recursive?: boolean }): Promise<CloudflareMkdirResult>;
  setEnvVars?(envVars: Record<string, string | undefined>): Promise<void>;
  setAllowedHosts?(hosts: string[]): Promise<void>;
  setDeniedHosts?(hosts: string[]): Promise<void>;
  /** Tear the container down. Not the same as "stop" — there is no snapshot. */
  destroy?(): Promise<void>;
}

/** Structural slice of the SDK's `SandboxOptions`, forwarded to `getSandbox`. */
export interface CloudflareGetSandboxOptions {
  /** Idle sleep window — `"10m"`, `"1h"`, or seconds. SDK default `"10m"`. */
  sleepAfter?: string | number;
  /** Never auto-sleep. Requires an explicit `destroy()`. SDK default false. */
  keepAlive?: boolean;
  /** Lowercase the DO id. Recommended — and required for preview URLs. */
  normalizeId?: boolean;
  containerTimeouts?: {
    instanceGetTimeoutMS?: number;
    portReadyTimeoutMS?: number;
    waitIntervalMS?: number;
  };
}

/**
 * SDK entry point, injectable for tests. In a Worker, build one with
 * {@link cloudflareSdkClient}; the namespace binding is captured there so
 * this interface stays free of Workers types.
 */
export interface CloudflareSandboxClient {
  getSandbox(id: string, options?: CloudflareGetSandboxOptions): CloudflareSandboxHandle;
}

/**
 * Bind `@cloudflare/sandbox`'s `getSandbox` to a Durable Object namespace,
 * producing the adapter's structural client. This is the *only* place the
 * real SDK types meet the adapter's, so it is also the only cast:
 *
 * ```ts
 * import { getSandbox } from "@cloudflare/sandbox";
 *
 * const sandbox = createCloudflareSandbox({
 *   name: `conv-${conversationId}`,
 *   client: cloudflareSdkClient(getSandbox, env.Sandbox),
 *   networkPolicy: { allow: ["data.example.org"] },
 * });
 * ```
 *
 * The adapter itself never imports `@cloudflare/sandbox`, so it type-checks
 * and unit-tests in plain bun — the SDK only runs inside `workerd`.
 */
export function cloudflareSdkClient<NS, H>(
  getSandbox: (ns: NS, id: string, options?: CloudflareGetSandboxOptions) => H,
  namespace: NS,
): CloudflareSandboxClient {
  return {
    getSandbox: (id, options): CloudflareSandboxHandle =>
      getSandbox(namespace, id, options) as unknown as CloudflareSandboxHandle,
  };
}

export interface CloudflareSandboxOptions {
  /**
   * Durable Object id — the sandbox's identity *and* its persistence key.
   * The same name reattaches to the same container (and its disk) across
   * requests, isolates and sessions. This is Cloudflare's `getOrCreate`.
   */
  name: string;
  /** SDK entry point. See {@link cloudflareSdkClient}. */
  client: CloudflareSandboxClient;
  /**
   * Egress firewall. Defaults to `"deny-all"` — drover sandboxes ship locked
   * down.
   *
   * **Read this before trusting it.** Cloudflare's real deny-all switch is
   * `enableInternet = false` on your `Sandbox` Durable Object subclass; the
   * host lists this adapter installs are an *allowlist on top of that*. The
   * adapter cannot read `enableInternet` over RPC, so it cannot assert the
   * base posture. Declare it yourself:
   *
   * ```ts
   * export class MySandbox extends Sandbox<Env> {
   *   override enableInternet = false;
   *   // Required to see (and therefore modify) HTTPS egress. Defaults to
   *   // false on Container; Sandbox does not override it. Left false, an
   *   // allowed HTTPS host is a transparent tunnel — outbound handlers
   *   // never run and no header can be added.
   *   override interceptHttps = true;
   * }
   * // Without this re-export the DO throws on the first list install:
   * // "ctx.exports.ContainerProxy is undefined".
   * export { ContainerProxy } from "@cloudflare/sandbox";
   * ```
   *
   * With `interceptHttps = true` the platform mints an ephemeral CA at
   * `/etc/cloudflare/certs/cloudflare-containers-ca.crt` inside the
   * container. The stock sandbox image trusts it; anything with its own
   * trust store (python `certifi`, node, curl built against a pinned
   * bundle) needs `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` /
   * `NODE_EXTRA_CA_CERTS` pointed at a bundle that includes it, or TLS
   * verification fails for every intercepted host. The CA-free alternative
   * (what the SDK's own git/s3/r2 credential proxies do): have the container
   * speak plain `http://` to the host, and let the `outboundByHost` handler
   * upgrade to `https://` and stamp the credential before forwarding.
   *
   * Anything other than `"allow-all"` requires the handle to expose
   * `setAllowedHosts` / `setDeniedHosts`; the adapter fails closed with a
   * `SandboxError` when they are missing rather than running wide open.
   */
  networkPolicy?: CloudflareNetworkPolicy;
  /** Options forwarded to `getSandbox`. `normalizeId` defaults to true. */
  sandboxOptions?: CloudflareGetSandboxOptions;
  /**
   * Environment for everything this adapter runs.
   *
   * Applied two ways, deliberately:
   *
   * 1. `setEnvVars` once per acquire. **This only reaches a container that has
   *    not started yet** — the SDK's `setEnvVars` mutates the Durable Object's
   *    `envVars` record, and that record is handed to the container exactly
   *    once, in the `container.start()` config. Call it against a container
   *    that is already running (a warm sandbox reattached from a later
   *    isolate) and it is a silent no-op until the next cold start.
   * 2. Merged under `ExecOptions.env` on **every** `run`, so it is in effect
   *    regardless of container warmth. Per-call `env` wins on key collisions.
   *
   * Secrets do not belong here either way: they would be visible to every
   * process in the container. Inject them at the egress handler instead.
   */
  env?: Record<string, string>;
  /**
   * Default cwd for `run` and the base for `resolvePath`. Default
   * `"/workspace"` — the container's working root.
   */
  cwd?: string;
  /**
   * Restrict `assertPathAllowed` to these prefixes. Omit (the default) to
   * allow every path: the container is the isolation boundary, exactly as
   * with the Vercel adapter. Set it when you also want intra-container
   * confinement (e.g. `["/workspace"]`).
   */
  allowedRoots?: readonly string[];
  /**
   * Ran once per adapter instance, right after the stub is acquired and the
   * env/egress policy are applied. Note this is NOT "on container create" —
   * the SDK gives no such signal — so it fires on every cold isolate. Make
   * it idempotent (a marker file is the usual guard).
   */
  onAcquire?: (sandbox: CloudflareSandboxHandle) => Promise<void>;
  /** Per-call default exec timeout, ms. Default 30_000 (matches just-bash). */
  timeoutMs?: number;
  /**
   * Tail cap per output stream, in bytes. Default 16 KiB. Longer output is
   * truncated to its tail with a note, so a runaway `cat` cannot blow the
   * transcript.
   */
  maxOutputBytes?: number;
  /**
   * `maxBytes` handed to the SDK's `output()` — the cap on what crosses the
   * RPC boundary at all, before the tail cap above. Default 1 MiB.
   */
  transportMaxBytes?: number;
  /** How long to wait after SIGKILL for exit code + output harvest, ms. Default 2_000. */
  killGraceMs?: number;
  /** Telemetry identifier. Default `"cloudflare-sandbox"`. */
  id?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_TRANSPORT_MAX_BYTES = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_CWD = "/workspace";
// The container-side timeout backstop trails the adapter's own deadline so
// the client-side race decides `killed` in the normal case.
const SDK_TIMEOUT_PAD_MS = 500;
const SIGKILL = 9;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/**
 * The SDK's "the container behind this stub was replaced" family.
 *
 * Matched on the SDK's error `code` first (`OPERATION_INTERRUPTED` with a
 * `runtime_replaced` reason, `STALE_PROCESS_HANDLE`) and on its messages as a
 * fallback, through up to eight `cause` links, because the SDK wraps DO
 * transport failures before they reach the adapter. Also true for a
 * `SandboxError` this adapter minted from one, so callers can classify the
 * error they were handed without keeping the original.
 */
export function isRuntimeReplacedError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    if (typeof current === "object") {
      const { code, message, cause } = current as {
        code?: unknown;
        message?: unknown;
        cause?: unknown;
      };
      if (code === "OPERATION_INTERRUPTED" || code === "STALE_PROCESS_HANDLE") return true;
      if (typeof message === "string" && RUNTIME_REPLACED_PATTERN.test(message)) return true;
      current = cause;
      continue;
    }
    return false;
  }
  return false;
}

/** Appended to a wrapped message that was recognised by `code` alone. */
const RUNTIME_REPLACED_TAG = "(sandbox runtime replaced)";

const RUNTIME_REPLACED_PATTERN =
  /interrupted while the platform was updating the sandbox runtime|refers to a previous runtime incarnation|runtime incarnation does not match|\(sandbox runtime replaced\)/i;

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
  return { promise, clear: (): void => clearTimeout(timer) };
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
 * Pure POSIX `normalize`. Hand-rolled rather than `node:path/posix` so the
 * adapter needs no `nodejs_compat` flag in the consuming Worker. Trailing
 * slashes are dropped (node keeps them); nothing else differs for the
 * absolute paths a container deals in.
 */
export function normalizePosix(p: string): string {
  const absolute = p.startsWith("/");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      const last = parts[parts.length - 1];
      if (parts.length > 0 && last !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(seg);
  }
  const joined = parts.join("/");
  if (absolute) return `/${joined}`;
  return joined === "" ? "." : joined;
}

/**
 * Cloudflare Sandbox adapter: every op runs inside a Cloudflare **container**
 * fronted by a `Sandbox` Durable Object. **A real isolation boundary** — the
 * container is remote, has its own filesystem, and (with
 * `enableInternet = false` on the DO) no egress — so `bash` is safe to
 * compose by default and `capabilities.shell` is unconditionally `true`.
 *
 * ### Identity and persistence
 * `getSandbox(ns, name)` *is* the getOrCreate: the name is the Durable Object
 * id, so the same name reattaches to the same container and the same disk.
 * There is no Vercel-style snapshot on stop — the container simply sleeps
 * after `sleepAfter` and wakes with its disk intact. For durable, portable
 * state use the SDK's `createBackup`/`restoreBackup` (R2) directly on the
 * handle; the adapter does not wrap them.
 *
 * ### What differs from `@droveragent/sandbox-vercel`
 * - **Egress is DO-side, not per-acquire.** See
 *   {@link CloudflareSandboxOptions.networkPolicy}.
 * - **No `AbortSignal` on `exec`.** The SDK's `ExecOptions` has `cwd`, `env`
 *   and `timeout` only, so cancellation is a client-side race plus an
 *   explicit `kill(9)`, exactly as the Vercel adapter does for timeouts.
 * - **`stop()` does not snapshot.** It drops the memoised handle so the next
 *   op re-acquires; the container sleeps on its own schedule. Use
 *   {@link CloudflareSandboxAdapter.destroy} to actually tear it down.
 * - **No node builtins.** Path handling and byte counting use plain string
 *   ops and `TextEncoder`, so no `nodejs_compat` flag is needed.
 *
 * `run` enforces `timeoutMs`/`signal` with its own deadline race and
 * SIGKILLs the container-side process on expiry, resolving with
 * `killed: true` (matching just-bash) rather than failing, so the tool layer
 * can report the partial result. `SandboxError` is reserved for
 * SDK/transport failures, including failure to acquire within the deadline.
 */
export interface CloudflareSandboxAdapter extends SandboxAdapter {
  /** List directory entry names inside the container (always implemented here). */
  readdir(path: string): Effect.Effect<ReadonlyArray<string>, SandboxError, never>;
  /** `mkdir -p` inside the container. */
  mkdir(path: string): Effect.Effect<void, SandboxError, never>;
  /**
   * Drop the memoised handle. The container is left running and sleeps on
   * its own `sleepAfter` schedule with its disk intact; the next operation
   * re-acquires it. A no-op when nothing was acquired. Safe to call repeatedly.
   */
  stop(): Effect.Effect<void, SandboxError, never>;
  /**
   * Tear the container down for good (`Sandbox.destroy()`), then drop the
   * handle. Unlike {@link CloudflareSandboxAdapter.stop} this is destructive:
   * the filesystem does not survive.
   */
  destroy(): Effect.Effect<void, SandboxError, never>;
}

export function createCloudflareSandbox(opts: CloudflareSandboxOptions): CloudflareSandboxAdapter {
  const id = opts.id ?? "cloudflare-sandbox";
  const defaultTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const transportMaxBytes = opts.transportMaxBytes ?? DEFAULT_TRANSPORT_MAX_BYTES;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const baseCwd = normalizePosix(opts.cwd ?? DEFAULT_CWD);
  const policy: CloudflareNetworkPolicy = opts.networkPolicy ?? "deny-all";
  const allowedRoots = opts.allowedRoots?.map((r) => normalizePosix(r));
  const getSandboxOptions: CloudflareGetSandboxOptions = {
    normalizeId: true,
    ...opts.sandboxOptions,
  };

  const applyNetworkPolicy = async (sandbox: CloudflareSandboxHandle): Promise<void> => {
    if (policy === "allow-all") return; // the DO's own posture stands
    const allow = policy === "deny-all" ? [] : [...policy.allow];
    const deny = policy === "deny-all" ? [] : [...(policy.deny ?? [])];
    if (!sandbox.setAllowedHosts || !sandbox.setDeniedHosts) {
      // Fail closed: silently skipping the lists would leave the container
      // on whatever posture the DO happens to have.
      throw new SandboxError({
        runId: "(sandbox)",
        op: "exec",
        message:
          `network policy "${policy === "deny-all" ? "deny-all" : "allowlist"}" requires the sandbox handle to expose ` +
          "setAllowedHosts/setDeniedHosts (the @cloudflare/containers egress controls). " +
          'Pass networkPolicy: "allow-all" to opt out of adapter-managed egress.',
      });
    }
    await sandbox.setAllowedHosts(allow);
    await sandbox.setDeniedHosts(deny);
  };

  // Lazy, memoised acquisition. `getSandbox` itself is synchronous (it just
  // builds a DO stub), but the one-time setup around it is not, so the same
  // memoisation shape as the Vercel adapter applies: concurrent first ops
  // share one setup; a failure resets so the next op can retry.
  let sandboxP: Promise<CloudflareSandboxHandle> | null = null;
  const acquire = (): Promise<CloudflareSandboxHandle> => {
    sandboxP ??= (async (): Promise<CloudflareSandboxHandle> => {
      const sandbox = opts.client.getSandbox(opts.name, getSandboxOptions);
      if (opts.env && sandbox.setEnvVars) await sandbox.setEnvVars({ ...opts.env });
      await applyNetworkPolicy(sandbox);
      if (opts.onAcquire) await opts.onAcquire(sandbox);
      return sandbox;
    })().catch((err: unknown) => {
      sandboxP = null;
      throw err;
    });
    return sandboxP;
  };

  /**
   * Wrap an SDK failure, and drop the memoised handle when the SDK reports
   * that the container behind it was REPLACED.
   *
   * When the container restarts under a live stub — the platform killed it
   * (out of memory is the usual reason), it crashed, or the runtime was
   * updated — the SDK fails the in-flight op with `OPERATION_INTERRUPTED`
   * ("interrupted while the platform was updating the sandbox runtime") and
   * every later op on the SAME stub with the same error, or with
   * `STALE_PROCESS_HANDLE` ("Process handle refers to a previous runtime
   * incarnation"). Those are not retryable in place, but a FRESH acquire is:
   * `getSandbox` addresses the same Durable Object, whose new runtime
   * incarnation accepts work. Without this reset one container restart wedged
   * every remaining tool call of the turn.
   *
   * The disk did not survive the restart. The error is returned unchanged so
   * the caller can recognise it (see {@link isRuntimeReplacedError}) and
   * re-stage whatever it had written.
   */
  const failed = (op: "exec" | "read" | "write", err: unknown, path?: string): SandboxError => {
    if (!isRuntimeReplacedError(err)) return sandboxError(op, err, path);
    sandboxP = null;
    const wrapped = sandboxError(op, err, path);
    // `SandboxError` carries only a message, so an SDK error recognised by its
    // `code` alone would stop being recognisable once wrapped. Tag it.
    return RUNTIME_REPLACED_PATTERN.test(wrapped.message)
      ? wrapped
      : new SandboxError({
          runId: wrapped.runId,
          op: wrapped.op,
          ...(wrapped.path !== undefined ? { path: wrapped.path } : {}),
          message: `${wrapped.message} ${RUNTIME_REPLACED_TAG}`,
        });
  };

  const capTail = (text: string): string => {
    const bytes = encoder.encode(text);
    if (bytes.length <= maxOutputBytes) return text;
    const tail = decoder
      .decode(bytes.subarray(bytes.length - maxOutputBytes))
      // drop the partial code point a byte-boundary slice can leave behind
      .replace(/^�+/, "");
    return `[truncated: showing last ${maxOutputBytes} of ${bytes.length} bytes]\n${tail}`;
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
    // Already-aborted: report killed without ever touching the container
    // (matches just-bash).
    if (runOpts?.signal?.aborted) return interruptedResult("abort", timeoutMs, "", "");
    const deadline = startDeadline(timeoutMs);
    const abort = watchAbort(runOpts?.signal);
    try {
      // Acquisition counts against the exec deadline — a cold container can
      // take minutes to provision and must not hang the tool call. No process
      // exists yet, so an expiry here is infra failure (SandboxError), not a
      // killed result.
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

      // `setEnvVars` only lands on a container that has yet to start, so the
      // adapter-wide env rides on every exec too. Per-call env wins.
      const execEnv =
        opts.env !== undefined || runOpts?.env !== undefined
          ? { ...opts.env, ...runOpts?.env }
          : undefined;
      const startP = acquired.sandbox
        .exec([cmd, ...args], {
          cwd: runOpts?.cwd ?? baseCwd,
          // Container-side backstop; the client-side race is the primary.
          timeout: timeoutMs + SDK_TIMEOUT_PAD_MS,
          ...(execEnv !== undefined ? { env: execEnv } : {}),
        })
        .then(
          (process) => ({ kind: "started" as const, process }),
          (error: unknown) => ({ kind: "start-error" as const, error }),
        );
      const started = await Promise.race([startP, deadline.promise, abort.promise]);
      if (started.kind === "start-error") throw started.error;
      if (started.kind !== "started") {
        // Reap the orphan if the spawn ever completes.
        void startP.then((s) => {
          if (s.kind === "started") void s.process.kill(SIGKILL).catch(() => {});
        });
        return interruptedResult(started.kind, timeoutMs, "", "");
      }

      // One `output()` call, raced — a second call after the kill would be a
      // second log replay, so the grace window reuses this same promise.
      const outputP = started.process
        .output({ encoding: "utf8", maxBytes: transportMaxBytes })
        .then(
          (out) => ({ kind: "finished" as const, out }),
          (error: unknown) => ({ kind: "output-error" as const, error }),
        );
      const first = await Promise.race([outputP, deadline.promise, abort.promise]);
      if (first.kind === "output-error") throw first.error;
      if (first.kind === "finished") {
        return {
          exitCode: first.out.exitCode,
          stdout: capTail(first.out.stdout),
          stderr: capTail(first.out.stderr),
          // The container's own `timeout` can fire just before ours does.
          killed: first.out.timedOut,
        };
      }

      // Deadline or abort: kill, then a bounded grace to harvest the exit
      // code and any partial output.
      await started.process.kill(SIGKILL).catch(() => {});
      const grace = startDeadline(killGraceMs);
      const graced = await Promise.race([outputP, grace.promise]);
      grace.clear();
      if (graced.kind === "finished") {
        return interruptedResult(
          first.kind,
          timeoutMs,
          graced.out.stdout,
          graced.out.stderr,
          graced.out.exitCode,
        );
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
      catch: (err): SandboxError => failed("exec", err),
    });

  const readFile = (p: string): Effect.Effect<string, SandboxError, never> =>
    Effect.tryPromise({
      try: async (): Promise<string> => {
        const sandbox = await acquire();
        // Force utf-8: the default auto-detects and hands back base64 for
        // anything it thinks is binary, which the adapter contract (a
        // `string` of file contents) cannot express.
        const result = await sandbox.readFile(p, { encoding: "utf-8" });
        if (!result.success) throw new Error(`readFile failed for '${p}'`);
        return result.content;
      },
      catch: (err): SandboxError => failed("read", err, p),
    });

  const writeFile = (p: string, contents: string): Effect.Effect<void, SandboxError, never> =>
    Effect.tryPromise({
      try: async (): Promise<void> => {
        const sandbox = await acquire();
        const result = await sandbox.writeFile(p, contents);
        if (!result.success) throw new Error(`writeFile failed for '${p}'`);
      },
      catch: (err): SandboxError => failed("write", err, p),
    });

  const readdir = (p: string): Effect.Effect<ReadonlyArray<string>, SandboxError, never> =>
    Effect.tryPromise({
      try: async (): Promise<ReadonlyArray<string>> => {
        const sandbox = await acquire();
        const result = await sandbox.listFiles(p);
        if (!result.success) throw new Error(`listFiles failed for '${p}'`);
        return result.files.map((f) => f.name);
      },
      catch: (err): SandboxError => failed("read", err, p),
    });

  const mkdir = (p: string): Effect.Effect<void, SandboxError, never> =>
    Effect.tryPromise({
      try: async (): Promise<void> => {
        const sandbox = await acquire();
        if (!sandbox.mkdir) throw new Error("sandbox handle does not implement mkdir");
        const result = await sandbox.mkdir(p, { recursive: true });
        if (!result.success) throw new Error(`mkdir failed for '${p}'`);
      },
      catch: (err): SandboxError => failed("write", err, p),
    });

  const resolvePath = (p: string, cwd: string): string =>
    p.startsWith("/") ? normalizePosix(p) : normalizePosix(`${cwd || baseCwd}/${p}`);

  const assertPathAllowed = (p: string): Effect.Effect<void, SandboxError, never> => {
    // No roots configured: the container *is* the boundary, and there is
    // nothing of the host's to escape to — same structural argument as the
    // Vercel adapter and just-bash's mount namespace.
    if (!allowedRoots || allowedRoots.length === 0) return Effect.void;
    const target = resolvePath(p, baseCwd);
    const ok = allowedRoots.some(
      (root) => target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`),
    );
    return ok
      ? Effect.void
      : Effect.fail(
          new SandboxError({
            runId: "(sandbox)",
            op: "read",
            path: target,
            message: `path '${target}' is outside the sandbox's allowed roots (${allowedRoots.join(", ")})`,
          }),
        );
  };

  const release = (
    op: (sandbox: CloudflareSandboxHandle) => Promise<void>,
  ): Effect.Effect<void, SandboxError, never> =>
    Effect.tryPromise({
      try: async (): Promise<void> => {
        const pending = sandboxP;
        if (!pending) return;
        // Reset first: the next op re-acquires.
        sandboxP = null;
        const sandbox = await pending.catch(() => null);
        if (sandbox) await op(sandbox);
      },
      catch: (err): SandboxError => failed("exec", err),
    });

  return {
    id,
    // The container is a real isolation boundary, so `bash` composes safely.
    capabilities: { shell: true },
    run,
    readFile,
    writeFile,
    readdir,
    mkdir,
    resolvePath,
    assertPathAllowed,
    stop: () => release(async () => {}),
    destroy: () =>
      release(async (sandbox) => {
        if (sandbox.destroy) await sandbox.destroy();
      }),
  };
}
