import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCloudflareSandbox, cloudflareSdkClient, normalizePosix } from "../src/index.ts";
import type {
  CloudflareExecOptions,
  CloudflareGetSandboxOptions,
  CloudflareListFilesResult,
  CloudflareProcessHandle,
  CloudflareProcessOutput,
  CloudflareReadFileResult,
  CloudflareSandboxClient,
  CloudflareSandboxHandle,
  CloudflareSandboxOptions,
  CloudflareWriteFileResult,
} from "../src/index.ts";

interface RunBehavior {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** The container-side `ExecOptions.timeout` fired. */
  timedOut?: boolean;
  truncated?: boolean;
  /** `output()` resolves after this delay. Default 0. */
  delayMs?: number;
  /** `output()` stays pending until `kill()` fires, then resolves with exit 137. */
  hangUntilKill?: boolean;
  /** `output()` never resolves, even after `kill()`. */
  hangForever?: boolean;
  /** `exec()` rejects with this error. */
  startError?: Error;
}

interface OutputCall {
  encoding: string;
  maxBytes?: number;
  timeout?: number;
}

interface MockState {
  getSandboxCalls: Array<{ id: string; options: CloudflareGetSandboxOptions | undefined }>;
  /** One entry per completed acquire setup. */
  acquires: number;
  execCalls: Array<{
    command: ReadonlyArray<string>;
    options: CloudflareExecOptions | undefined;
  }>;
  outputCalls: OutputCall[];
  kills: number[];
  destroys: number;
  envVarCalls: Array<Record<string, string | undefined>>;
  allowedHostCalls: string[][];
  deniedHostCalls: string[][];
  listCalls: string[];
  mkdirCalls: Array<{ path: string; recursive?: boolean }>;
  readOptions: Array<{ encoding?: string } | undefined>;
  files: Map<string, string>;
}

interface MockOptions {
  behavior?: RunBehavior;
  files?: Record<string, string>;
  /** `setAllowedHosts` never resolves — models a cold container that won't come up. */
  acquireHang?: boolean;
  /** First acquire rejects; subsequent ones succeed. */
  failFirstAcquire?: boolean;
  /** Handle exposes no egress controls (a bare `ISandbox`). */
  omitEgressControls?: boolean;
  /** Handle exposes no `mkdir`. */
  omitMkdir?: boolean;
  /** Handle exposes no `destroy`. */
  omitDestroy?: boolean;
  /** `writeFile`/`readFile`/`listFiles` return `success: false`. */
  failOps?: boolean;
}

function makeMock(opts: MockOptions = {}): { client: CloudflareSandboxClient; state: MockState } {
  const behavior = opts.behavior ?? {};
  const state: MockState = {
    getSandboxCalls: [],
    acquires: 0,
    execCalls: [],
    outputCalls: [],
    kills: [],
    destroys: 0,
    envVarCalls: [],
    allowedHostCalls: [],
    deniedHostCalls: [],
    listCalls: [],
    mkdirCalls: [],
    readOptions: [],
    files: new Map(Object.entries(opts.files ?? {})),
  };

  const outputWith = (exitCode: number): CloudflareProcessOutput => ({
    stdout: behavior.stdout ?? "",
    stderr: behavior.stderr ?? "",
    exitCode,
    timedOut: behavior.timedOut ?? false,
    truncated: behavior.truncated ?? false,
  });

  const makeProcess = (): CloudflareProcessHandle => {
    let resolveOutput: ((o: CloudflareProcessOutput) => void) | undefined;
    return {
      id: "proc_1",
      output: (options): Promise<CloudflareProcessOutput> => {
        state.outputCalls.push(options);
        return new Promise<CloudflareProcessOutput>((resolve) => {
          resolveOutput = resolve;
          if (behavior.hangForever || behavior.hangUntilKill) return;
          setTimeout(() => resolve(outputWith(behavior.exitCode ?? 0)), behavior.delayMs ?? 0);
        });
      },
      kill: async (signal): Promise<void> => {
        state.kills.push(signal ?? 15);
        if (behavior.hangUntilKill && resolveOutput) resolveOutput(outputWith(137));
      },
    };
  };

  let failNext = opts.failFirstAcquire ?? false;

  const handle: CloudflareSandboxHandle = {
    exec: async (command, options): Promise<CloudflareProcessHandle> => {
      state.execCalls.push({ command, options });
      if (behavior.startError) throw behavior.startError;
      return makeProcess();
    },
    readFile: async (path, options): Promise<CloudflareReadFileResult> => {
      state.readOptions.push(options);
      if (opts.failOps) return { success: false, content: "" };
      const v = state.files.get(path);
      if (v === undefined) throw new Error(`ENOENT: no such file '${path}'`);
      return { success: true, content: v };
    },
    writeFile: async (path, content): Promise<CloudflareWriteFileResult> => {
      if (opts.failOps) return { success: false };
      state.files.set(path, content);
      return { success: true };
    },
    listFiles: async (path): Promise<CloudflareListFilesResult> => {
      state.listCalls.push(path);
      if (opts.failOps) return { success: false, files: [] };
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = [...state.files.keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .map((k) => ({ name: k.slice(prefix.length) }));
      return { success: true, files: names };
    },
    setEnvVars: async (envVars): Promise<void> => {
      state.envVarCalls.push(envVars);
    },
    ...(opts.omitMkdir
      ? {}
      : {
          mkdir: async (path, mkdirOpts): Promise<{ success: boolean }> => {
            state.mkdirCalls.push({ path, ...mkdirOpts });
            return { success: true };
          },
        }),
    ...(opts.omitEgressControls
      ? {}
      : {
          setAllowedHosts: async (hosts): Promise<void> => {
            if (failNext) {
              failNext = false;
              throw new Error("container provisioning failed");
            }
            if (opts.acquireHang) return new Promise<never>(() => {});
            state.allowedHostCalls.push(hosts);
          },
          setDeniedHosts: async (hosts): Promise<void> => {
            state.deniedHostCalls.push(hosts);
          },
        }),
    ...(opts.omitDestroy
      ? {}
      : {
          destroy: async (): Promise<void> => {
            state.destroys += 1;
          },
        }),
  };

  const client: CloudflareSandboxClient = {
    getSandbox: (id, options): CloudflareSandboxHandle => {
      state.getSandboxCalls.push({ id, options });
      state.acquires += 1;
      return handle;
    },
  };

  return { client, state };
}

const sb = (
  adapterOpts: Omit<CloudflareSandboxOptions, "client" | "name"> & { name?: string } = {},
  mockOpts: MockOptions = {},
): { adapter: ReturnType<typeof createCloudflareSandbox>; state: MockState } => {
  const { client, state } = makeMock(mockOpts);
  return {
    adapter: createCloudflareSandbox({
      name: adapterOpts.name ?? "test-sandbox",
      ...adapterOpts,
      client,
    }),
    state,
  };
};

describe("normalizePosix", () => {
  test("collapses . and .. and redundant separators", () => {
    expect(normalizePosix("/workspace//out/./a.txt")).toBe("/workspace/out/a.txt");
    expect(normalizePosix("/workspace/out/../a.txt")).toBe("/workspace/a.txt");
    expect(normalizePosix("/../etc/passwd")).toBe("/etc/passwd");
    expect(normalizePosix("/workspace/")).toBe("/workspace");
    expect(normalizePosix("/")).toBe("/");
  });

  test("keeps leading .. on relative paths and yields . for empty", () => {
    expect(normalizePosix("../up")).toBe("../up");
    expect(normalizePosix("a/../..")).toBe("..");
    expect(normalizePosix("")).toBe(".");
    expect(normalizePosix("./")).toBe(".");
  });
});

describe("cloudflareSdkClient", () => {
  test("binds a namespace into the structural client", () => {
    const calls: Array<[string, string, CloudflareGetSandboxOptions | undefined]> = [];
    const fakeHandle = {} as CloudflareSandboxHandle;
    const client = cloudflareSdkClient(
      (ns: string, id: string, options?: CloudflareGetSandboxOptions) => {
        calls.push([ns, id, options]);
        return fakeHandle;
      },
      "NS",
    );
    expect(client.getSandbox("abc", { normalizeId: true })).toBe(fakeHandle);
    expect(calls).toEqual([["NS", "abc", { normalizeId: true }]]);
  });
});

describe("createCloudflareSandbox", () => {
  test("shell capability is unconditionally true — the container is the boundary", () => {
    expect(sb().adapter.capabilities.shell).toBe(true);
  });

  test("id defaults to cloudflare-sandbox and is overridable", () => {
    expect(sb().adapter.id).toBe("cloudflare-sandbox");
    expect(sb({ id: "cf-1" }).adapter.id).toBe("cf-1");
  });

  test("acquire is lazy and memoised: nothing until first op, one setup for many ops", async () => {
    const { adapter, state } = sb({}, { behavior: { stdout: "hi\n" } });
    expect(state.getSandboxCalls.length).toBe(0);

    await Effect.runPromise(adapter.run("echo", ["hi"]));
    await Effect.runPromise(adapter.writeFile("/workspace/a.txt", "x"));
    await Effect.runPromise(adapter.readFile("/workspace/a.txt"));
    expect(state.getSandboxCalls.length).toBe(1);
  });

  test("getSandbox is keyed on `name` and normalizes ids by default", async () => {
    const { adapter, state } = sb({ name: "conv-Abc123" });
    await Effect.runPromise(adapter.writeFile("/workspace/x", ""));
    expect(state.getSandboxCalls[0]?.id).toBe("conv-Abc123");
    expect(state.getSandboxCalls[0]?.options).toEqual({ normalizeId: true });
  });

  test("sandboxOptions pass through and can override normalizeId", async () => {
    const { adapter, state } = sb({
      sandboxOptions: {
        normalizeId: false,
        sleepAfter: "1h",
        keepAlive: true,
        containerTimeouts: { portReadyTimeoutMS: 180_000 },
      },
    });
    await Effect.runPromise(adapter.writeFile("/workspace/x", ""));
    expect(state.getSandboxCalls[0]?.options).toEqual({
      normalizeId: false,
      sleepAfter: "1h",
      keepAlive: true,
      containerTimeouts: { portReadyTimeoutMS: 180_000 },
    });
  });

  test("default network policy installs an empty allowlist (deny-all)", async () => {
    const { adapter, state } = sb();
    await Effect.runPromise(adapter.writeFile("/workspace/x", ""));
    expect(state.allowedHostCalls).toEqual([[]]);
    expect(state.deniedHostCalls).toEqual([[]]);
  });

  test("an allowlist policy installs allow + deny hosts", async () => {
    const { adapter, state } = sb({
      networkPolicy: { allow: ["data.gov.au", "r2.example.com"], deny: ["evil.test"] },
    });
    await Effect.runPromise(adapter.writeFile("/workspace/x", ""));
    expect(state.allowedHostCalls).toEqual([["data.gov.au", "r2.example.com"]]);
    expect(state.deniedHostCalls).toEqual([["evil.test"]]);
  });

  test("allow-all installs no host lists — the DO's own posture stands", async () => {
    const { adapter, state } = sb({ networkPolicy: "allow-all" });
    await Effect.runPromise(adapter.writeFile("/workspace/x", ""));
    expect(state.allowedHostCalls).toEqual([]);
    expect(state.deniedHostCalls).toEqual([]);
  });

  test("fails closed when the handle has no egress controls and a policy is set", async () => {
    const { adapter } = sb({}, { omitEgressControls: true });
    const r = await Effect.runPromise(Effect.either(adapter.writeFile("/workspace/x", "")));
    expect(r._tag).toBe("Left");
    if (r._tag === "Left") {
      expect(r.left._tag).toBe("SandboxError");
      expect(r.left.message).toContain("setAllowedHosts/setDeniedHosts");
    }
  });

  test("allow-all works without egress controls (the documented opt-out)", async () => {
    const { adapter } = sb({ networkPolicy: "allow-all" }, { omitEgressControls: true });
    await Effect.runPromise(adapter.writeFile("/workspace/x", "ok"));
    expect(await Effect.runPromise(adapter.readFile("/workspace/x"))).toBe("ok");
  });

  test("env is applied once via setEnvVars; onAcquire runs once per acquire", async () => {
    let acquired = 0;
    const { adapter, state } = sb({
      env: { PYTHONUNBUFFERED: "1" },
      onAcquire: async (): Promise<void> => {
        acquired += 1;
      },
    });
    await Effect.runPromise(adapter.writeFile("/workspace/x", ""));
    await Effect.runPromise(adapter.writeFile("/workspace/y", ""));
    expect(state.envVarCalls).toEqual([{ PYTHONUNBUFFERED: "1" }]);
    expect(acquired).toBe(1);
  });

  test("run: maps argv, cwd, env onto exec and returns the result", async () => {
    const { adapter, state } = sb(
      {},
      { behavior: { exitCode: 0, stdout: "out\n", stderr: "err\n" } },
    );
    const r = await Effect.runPromise(
      adapter.run("/bin/sh", ["-c", "echo out"], {
        cwd: "/workspace/job",
        env: { A: "1" },
        timeoutMs: 1_000,
      }),
    );
    expect(r).toEqual({ exitCode: 0, stdout: "out\n", stderr: "err\n", killed: false });

    const call = state.execCalls[0]!;
    // The SDK takes a single argv tuple, not cmd + args.
    expect(call.command).toEqual(["/bin/sh", "-c", "echo out"]);
    expect(call.options?.cwd).toBe("/workspace/job");
    expect(call.options?.env).toEqual({ A: "1" });
    // container-side backstop trails the adapter's own deadline
    expect(call.options?.timeout).toBe(1_500);
  });

  test("run: cwd defaults to the configured container root", async () => {
    const { adapter, state } = sb({ cwd: "/data" });
    await Effect.runPromise(adapter.run("true", []));
    expect(state.execCalls[0]?.options?.cwd).toBe("/data");
  });

  test("run: env key omitted when not provided", async () => {
    const { adapter, state } = sb();
    await Effect.runPromise(adapter.run("true", []));
    expect("env" in (state.execCalls[0]?.options ?? {})).toBe(false);
  });

  test("run: output() is asked for utf8 with a transport byte cap", async () => {
    const { adapter, state } = sb({ transportMaxBytes: 4_096 });
    await Effect.runPromise(adapter.run("true", []));
    expect(state.outputCalls[0]).toEqual({ encoding: "utf8", maxBytes: 4_096 });
  });

  test("run: non-zero exit code passes through, killed false", async () => {
    const { adapter } = sb({}, { behavior: { exitCode: 3, stderr: "boom\n" } });
    const r = await Effect.runPromise(adapter.run("false", []));
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toBe("boom\n");
    expect(r.killed).toBe(false);
  });

  test("run: a container-side timeout is reported as killed", async () => {
    const { adapter } = sb({}, { behavior: { exitCode: 137, timedOut: true } });
    const r = await Effect.runPromise(adapter.run("sleep", ["999"]));
    expect(r.killed).toBe(true);
    expect(r.exitCode).toBe(137);
  });

  test("timeoutMs: a hung command is SIGKILLed; exit code and output harvested", async () => {
    const { adapter, state } = sb({}, { behavior: { hangUntilKill: true, stdout: "partial" } });
    const r = await Effect.runPromise(adapter.run("sleep", ["999"], { timeoutMs: 100 }));
    expect(r.killed).toBe(true);
    expect(r.exitCode).toBe(137);
    expect(r.stdout).toBe("partial");
    expect(r.stderr).toContain("timed out after 100ms");
    // numeric SIGKILL — the SDK takes no string form
    expect(state.kills).toEqual([9]);
    // the grace window reuses the first output() promise, never a second call
    expect(state.outputCalls.length).toBe(1);
  });

  test("timeoutMs: kill grace bounded when output never returns", async () => {
    const { adapter, state } = sb({ killGraceMs: 50 }, { behavior: { hangForever: true } });
    const r = await Effect.runPromise(adapter.run("sleep", ["999"], { timeoutMs: 100 }));
    expect(r.killed).toBe(true);
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("timed out after 100ms");
    expect(state.kills).toEqual([9]);
  });

  test("an already-aborted signal kills the run without acquiring", async () => {
    const { adapter, state } = sb();
    const ac = new AbortController();
    ac.abort();
    const r = await Effect.runPromise(adapter.run("echo", ["hi"], { signal: ac.signal }));
    expect(r.killed).toBe(true);
    expect(state.getSandboxCalls.length).toBe(0);
  });

  test("mid-run abort kills the command — the SDK exec has no signal of its own", async () => {
    const { adapter, state } = sb({}, { behavior: { hangUntilKill: true } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const r = await Effect.runPromise(
      adapter.run("sleep", ["999"], { timeoutMs: 5_000, signal: ac.signal }),
    );
    expect(r.killed).toBe(true);
    expect(r.stderr).toContain("aborted");
    expect(state.kills).toEqual([9]);
  });

  test("output caps: long streams truncate to a noted tail", async () => {
    const { adapter } = sb(
      { maxOutputBytes: 1_024 },
      { behavior: { stdout: `${"a".repeat(99_999)}Z`, stderr: "e".repeat(2_048) } },
    );
    const r = await Effect.runPromise(adapter.run("cat", ["/dev/big"]));
    expect(r.stdout).toStartWith("[truncated: showing last 1024 of 100000 bytes]\n");
    expect(r.stdout).toEndWith("Z");
    expect(r.stdout.length).toBeLessThan(1_024 + 100);
    expect(r.stderr).toStartWith("[truncated: showing last 1024 of 2048 bytes]\n");
  });

  test("output caps count bytes, not code units, and never emit a partial rune", async () => {
    // "🌏" is 4 bytes; a 10-byte tail lands mid-character.
    const { adapter } = sb({ maxOutputBytes: 10 }, { behavior: { stdout: "🌏".repeat(5) } });
    const r = await Effect.runPromise(adapter.run("echo", ["globe"]));
    expect(r.stdout).toStartWith("[truncated: showing last 10 of 20 bytes]\n");
    expect(r.stdout).not.toContain("�");
    expect(r.stdout).toEndWith("🌏🌏");
  });

  test("output within the cap is untouched", async () => {
    const { adapter } = sb({ maxOutputBytes: 1_024 }, { behavior: { stdout: "small" } });
    const r = await Effect.runPromise(adapter.run("echo", ["small"]));
    expect(r.stdout).toBe("small");
  });

  test("readFile / writeFile roundtrip, forcing utf-8 on read", async () => {
    const { adapter, state } = sb();
    await Effect.runPromise(adapter.writeFile("/workspace/result.json", '{"ok":true}'));
    const read = await Effect.runPromise(adapter.readFile("/workspace/result.json"));
    expect(read).toBe('{"ok":true}');
    // Without an explicit encoding the SDK auto-detects and can hand back
    // base64, which the `string` contract cannot express.
    expect(state.readOptions[0]).toEqual({ encoding: "utf-8" });
  });

  test("readFile on a missing path fails with a SandboxError carrying op/path", async () => {
    const { adapter } = sb();
    const r = await Effect.runPromise(Effect.either(adapter.readFile("/workspace/nope.txt")));
    expect(r._tag).toBe("Left");
    if (r._tag === "Left") {
      expect(r.left._tag).toBe("SandboxError");
      expect(r.left.op).toBe("read");
      expect(r.left.path).toBe("/workspace/nope.txt");
    }
  });

  test("a success:false result is an error, not a silent empty string", async () => {
    const { adapter } = sb({}, { failOps: true });
    const write = await Effect.runPromise(Effect.either(adapter.writeFile("/workspace/a", "x")));
    expect(write._tag).toBe("Left");
    if (write._tag === "Left") expect(write.left.op).toBe("write");

    const read = await Effect.runPromise(Effect.either(adapter.readFile("/workspace/a")));
    expect(read._tag).toBe("Left");

    const list = await Effect.runPromise(Effect.either(adapter.readdir("/workspace")));
    expect(list._tag).toBe("Left");
  });

  test("readdir lists entry names via listFiles", async () => {
    const { adapter, state } = sb(
      {},
      { files: { "/out/a.csv": "1", "/out/b.csv": "2", "/out/nested/c": "", "/tmp/x": "" } },
    );
    const names = await Effect.runPromise(adapter.readdir("/out"));
    expect([...names].toSorted()).toEqual(["a.csv", "b.csv"]);
    expect(state.listCalls).toEqual(["/out"]);
  });

  test("mkdir is recursive; a handle without mkdir fails cleanly", async () => {
    const { adapter, state } = sb();
    await Effect.runPromise(adapter.mkdir("/workspace/out/deep"));
    expect(state.mkdirCalls).toEqual([{ path: "/workspace/out/deep", recursive: true }]);

    const { adapter: bare } = sb({}, { omitMkdir: true });
    const r = await Effect.runPromise(Effect.either(bare.mkdir("/workspace/x")));
    expect(r._tag).toBe("Left");
    if (r._tag === "Left") expect(r.left.message).toContain("does not implement mkdir");
  });

  test("run failure surfaces as SandboxError with op exec", async () => {
    const { adapter } = sb({}, { behavior: { startError: new Error("container exploded") } });
    const r = await Effect.runPromise(Effect.either(adapter.run("true", [])));
    expect(r._tag).toBe("Left");
    if (r._tag === "Left") {
      expect(r.left._tag).toBe("SandboxError");
      expect(r.left.op).toBe("exec");
      expect(r.left.message).toContain("container exploded");
    }
  });

  test("acquisition hang: run fails within the deadline as SandboxError", async () => {
    const { adapter } = sb({}, { acquireHang: true });
    const started = Date.now();
    const r = await Effect.runPromise(Effect.either(adapter.run("true", [], { timeoutMs: 50 })));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r._tag).toBe("Left");
    if (r._tag === "Left") expect(r.left.message).toContain("acquisition timed out");
  });

  test("failed acquire resets so the next op can retry", async () => {
    const { adapter, state } = sb({}, { failFirstAcquire: true });
    const first = await Effect.runPromise(Effect.either(adapter.writeFile("/workspace/a", "1")));
    expect(first._tag).toBe("Left");

    await Effect.runPromise(adapter.writeFile("/workspace/a", "1"));
    expect(state.getSandboxCalls.length).toBe(2);
  });

  test("stop(): drops the handle without destroying; next op re-acquires the same disk", async () => {
    const { adapter, state } = sb();
    await Effect.runPromise(adapter.writeFile("/workspace/keep.txt", "v1"));
    await Effect.runPromise(adapter.stop());
    expect(state.destroys).toBe(0);

    // Same DO name ⇒ same container ⇒ the file is still there.
    const read = await Effect.runPromise(adapter.readFile("/workspace/keep.txt"));
    expect(read).toBe("v1");
    expect(state.getSandboxCalls.length).toBe(2);
  });

  test("destroy(): tears the container down, then re-acquires on next use", async () => {
    const { adapter, state } = sb();
    await Effect.runPromise(adapter.writeFile("/workspace/x", ""));
    await Effect.runPromise(adapter.destroy());
    expect(state.destroys).toBe(1);
    await Effect.runPromise(adapter.writeFile("/workspace/y", ""));
    expect(state.getSandboxCalls.length).toBe(2);
  });

  test("stop()/destroy() before any op are no-ops; repeats are safe", async () => {
    const { adapter, state } = sb();
    await Effect.runPromise(adapter.stop());
    await Effect.runPromise(adapter.destroy());
    await Effect.runPromise(adapter.stop());
    expect(state.destroys).toBe(0);
    expect(state.getSandboxCalls.length).toBe(0);
  });

  test("destroy() on a handle without destroy still drops the handle", async () => {
    const { adapter, state } = sb({}, { omitDestroy: true });
    await Effect.runPromise(adapter.writeFile("/workspace/x", ""));
    await Effect.runPromise(adapter.destroy());
    await Effect.runPromise(adapter.writeFile("/workspace/y", ""));
    expect(state.getSandboxCalls.length).toBe(2);
  });

  test("resolvePath: pure posix join inside the container namespace", () => {
    const { adapter } = sb();
    expect(adapter.resolvePath("out/a.txt", "/workspace")).toBe("/workspace/out/a.txt");
    expect(adapter.resolvePath("/abs/b.txt", "/workspace")).toBe("/abs/b.txt");
    expect(adapter.resolvePath("../up.txt", "/workspace/job")).toBe("/workspace/up.txt");
  });

  test("resolvePath: an empty cwd falls back to the configured root", () => {
    const { adapter } = sb({ cwd: "/data" });
    expect(adapter.resolvePath("a.txt", "")).toBe("/data/a.txt");
  });

  test("assertPathAllowed succeeds everywhere by default — the container is the boundary", async () => {
    const { adapter } = sb();
    await Effect.runPromise(adapter.assertPathAllowed("/etc/passwd"));
  });

  test("allowedRoots adds intra-container confinement, traversal included", async () => {
    const { adapter } = sb({ allowedRoots: ["/workspace"] });
    await Effect.runPromise(adapter.assertPathAllowed("/workspace"));
    await Effect.runPromise(adapter.assertPathAllowed("/workspace/out/a.txt"));
    await Effect.runPromise(adapter.assertPathAllowed("out/a.txt"));

    for (const bad of ["/etc/passwd", "/workspace/../etc/passwd", "/workspace-evil/x"]) {
      const r = await Effect.runPromise(Effect.either(adapter.assertPathAllowed(bad)));
      expect(r._tag).toBe("Left");
      if (r._tag === "Left")
        expect(r.left.message).toContain("outside the sandbox's allowed roots");
    }
  });
});
