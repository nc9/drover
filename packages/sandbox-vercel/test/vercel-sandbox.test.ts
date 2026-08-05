import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as posix from "node:path/posix";

import { createVercelSandbox } from "../src/index.ts";
import type {
  VercelAcquireParams,
  VercelCommandHandle,
  VercelFinishedCommand,
  VercelFs,
  VercelRunCommandParams,
  VercelSandboxClient,
  VercelSandboxHandle,
  VercelSandboxOptions,
} from "../src/index.ts";

interface RunBehavior {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** wait() resolves after this delay. Default 0. */
  delayMs?: number;
  /** wait() stays pending until kill() fires, then resolves with exit 137. */
  hangUntilKill?: boolean;
  /** wait() never resolves, even after kill(). */
  hangForever?: boolean;
  /** runCommand() rejects with this error. */
  startError?: Error;
}

interface MockState {
  getOrCreateCalls: VercelAcquireParams[];
  runCalls: VercelRunCommandParams[];
  kills: string[];
  stops: number;
  files: Map<string, string>;
}

interface MockOptions {
  behavior?: RunBehavior;
  files?: Record<string, string>;
  /** getOrCreate never resolves. */
  acquireHang?: boolean;
  /** First getOrCreate rejects; subsequent calls succeed. */
  failFirstAcquire?: boolean;
}

function makeMock(opts: MockOptions = {}): { client: VercelSandboxClient; state: MockState } {
  const behavior = opts.behavior ?? {};
  const state: MockState = {
    getOrCreateCalls: [],
    runCalls: [],
    kills: [],
    stops: 0,
    files: new Map(Object.entries(opts.files ?? {})),
  };

  const finishedWith = (exitCode: number): VercelFinishedCommand => ({
    exitCode,
    stdout: async (): Promise<string> => behavior.stdout ?? "",
    stderr: async (): Promise<string> => behavior.stderr ?? "",
  });

  const makeCommand = (): VercelCommandHandle => {
    let resolveWait: ((f: VercelFinishedCommand) => void) | undefined;
    return {
      wait: (): Promise<VercelFinishedCommand> =>
        new Promise<VercelFinishedCommand>((resolve) => {
          resolveWait = resolve;
          if (behavior.hangForever || behavior.hangUntilKill) return;
          setTimeout(() => resolve(finishedWith(behavior.exitCode ?? 0)), behavior.delayMs ?? 0);
        }),
      kill: async (signal): Promise<void> => {
        state.kills.push(signal ?? "SIGTERM");
        if (behavior.hangUntilKill && resolveWait) resolveWait(finishedWith(137));
      },
    };
  };

  const fs: VercelFs = {
    readFile: async (p): Promise<string> => {
      const v = state.files.get(p);
      if (v === undefined) throw new Error(`ENOENT: no such file '${p}'`);
      return v;
    },
    writeFile: async (p, data): Promise<void> => {
      state.files.set(p, data);
    },
    readdir: async (p): Promise<string[]> =>
      [...state.files.keys()].filter((k) => posix.dirname(k) === p).map((k) => posix.basename(k)),
  };

  const handle: VercelSandboxHandle = {
    runCommand: async (params): Promise<VercelCommandHandle> => {
      state.runCalls.push(params);
      if (behavior.startError) throw behavior.startError;
      return makeCommand();
    },
    fs,
    stop: async (): Promise<unknown> => {
      state.stops += 1;
      return {};
    },
  };

  let failNext = opts.failFirstAcquire ?? false;
  const client: VercelSandboxClient = {
    getOrCreate: async (params): Promise<VercelSandboxHandle> => {
      state.getOrCreateCalls.push(params);
      if (failNext) {
        failNext = false;
        throw new Error("provisioning failed");
      }
      if (opts.acquireHang) return new Promise<never>(() => {});
      return handle;
    },
  };

  return { client, state };
}

const sb = (
  adapterOpts: Omit<VercelSandboxOptions, "client"> = {},
  mockOpts: MockOptions = {},
): { adapter: ReturnType<typeof createVercelSandbox>; state: MockState } => {
  const { client, state } = makeMock(mockOpts);
  return { adapter: createVercelSandbox({ ...adapterOpts, client }), state };
};

describe("createVercelSandbox", () => {
  test("shell capability is unconditionally true", () => {
    expect(sb().adapter.capabilities.shell).toBe(true);
  });

  test("id defaults to vercel-sandbox and is overridable", () => {
    expect(sb().adapter.id).toBe("vercel-sandbox");
    expect(sb({ id: "vs-1" }).adapter.id).toBe("vs-1");
  });

  test("acquire is lazy and memoised: no getOrCreate until first op, one for many ops", async () => {
    const { adapter, state } = sb({}, { behavior: { stdout: "hi\n" } });
    expect(state.getOrCreateCalls.length).toBe(0);

    await Effect.runPromise(adapter.run("echo", ["hi"]));
    await Effect.runPromise(adapter.writeFile("/tmp/a.txt", "x"));
    await Effect.runPromise(adapter.readFile("/tmp/a.txt"));
    expect(state.getOrCreateCalls.length).toBe(1);
  });

  test("getOrCreate params: defaults lock egress with deny-all", async () => {
    const { adapter, state } = sb();
    await Effect.runPromise(adapter.writeFile("/tmp/x", ""));
    expect(state.getOrCreateCalls[0]).toEqual({ networkPolicy: "deny-all" });
  });

  test("getOrCreate params: options pass through; snapshotId wins over runtime", async () => {
    const { adapter, state } = sb({
      name: "drover-run-1",
      snapshotId: "snap_abc",
      runtime: "python3.13",
      networkPolicy: "allow-all",
      timeout: 600_000,
      resources: { vcpus: 4 },
      persistent: false,
      snapshotExpiration: 0,
      keepLastSnapshots: { count: 3 },
      env: { FOO: "bar" },
    });
    await Effect.runPromise(adapter.writeFile("/tmp/x", ""));
    const params = state.getOrCreateCalls[0]!;
    expect(params.name).toBe("drover-run-1");
    expect(params.source).toEqual({ type: "snapshot", snapshotId: "snap_abc" });
    expect("runtime" in params).toBe(false);
    expect(params.networkPolicy).toBe("allow-all");
    expect(params.timeout).toBe(600_000);
    expect(params.resources).toEqual({ vcpus: 4 });
    expect(params.persistent).toBe(false);
    expect(params.snapshotExpiration).toBe(0);
    expect(params.keepLastSnapshots).toEqual({ count: 3 });
    expect(params.env).toEqual({ FOO: "bar" });
  });

  test("run: maps argv, cwd, env onto a detached runCommand and returns the result", async () => {
    const { adapter, state } = sb(
      {},
      { behavior: { exitCode: 0, stdout: "out\n", stderr: "err\n" } },
    );
    const r = await Effect.runPromise(
      adapter.run("/bin/sh", ["-c", "echo out"], {
        cwd: "/vercel/sandbox",
        env: { A: "1" },
        timeoutMs: 1_000,
      }),
    );
    expect(r).toEqual({ exitCode: 0, stdout: "out\n", stderr: "err\n", killed: false });

    const call = state.runCalls[0]!;
    expect(call.cmd).toBe("/bin/sh");
    expect(call.args).toEqual(["-c", "echo out"]);
    expect(call.cwd).toBe("/vercel/sandbox");
    expect(call.env).toEqual({ A: "1" });
    expect(call.detached).toBe(true);
    // sandbox-side backstop trails the adapter's own deadline
    expect(call.timeoutMs).toBe(1_500);
  });

  test("run: omits cwd/env keys when not provided", async () => {
    const { adapter, state } = sb();
    await Effect.runPromise(adapter.run("true", []));
    const call = state.runCalls[0]!;
    expect("cwd" in call).toBe(false);
    expect("env" in call).toBe(false);
  });

  test("run: non-zero exit code passes through, killed false", async () => {
    const { adapter } = sb({}, { behavior: { exitCode: 3, stderr: "boom\n" } });
    const r = await Effect.runPromise(adapter.run("false", []));
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toBe("boom\n");
    expect(r.killed).toBe(false);
  });

  test("timeoutMs: a hung command is SIGKILLed; exit code and output harvested", async () => {
    const { adapter, state } = sb({}, { behavior: { hangUntilKill: true, stdout: "partial" } });
    const r = await Effect.runPromise(adapter.run("sleep", ["999"], { timeoutMs: 100 }));
    expect(r.killed).toBe(true);
    expect(r.exitCode).toBe(137);
    expect(r.stdout).toBe("partial");
    expect(r.stderr).toContain("timed out after 100ms");
    expect(state.kills).toEqual(["SIGKILL"]);
  });

  test("timeoutMs: kill grace bounded when wait never returns", async () => {
    const { adapter, state } = sb({ killGraceMs: 50 }, { behavior: { hangForever: true } });
    const r = await Effect.runPromise(adapter.run("sleep", ["999"], { timeoutMs: 100 }));
    expect(r.killed).toBe(true);
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("timed out after 100ms");
    expect(state.kills).toEqual(["SIGKILL"]);
  });

  test("an already-aborted signal kills the run without acquiring", async () => {
    const { adapter, state } = sb();
    const ac = new AbortController();
    ac.abort();
    const r = await Effect.runPromise(adapter.run("echo", ["hi"], { signal: ac.signal }));
    expect(r.killed).toBe(true);
    expect(state.getOrCreateCalls.length).toBe(0);
  });

  test("mid-run abort kills the command", async () => {
    const { adapter, state } = sb({}, { behavior: { hangUntilKill: true } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const r = await Effect.runPromise(
      adapter.run("sleep", ["999"], { timeoutMs: 5_000, signal: ac.signal }),
    );
    expect(r.killed).toBe(true);
    expect(r.stderr).toContain("aborted");
    expect(state.kills).toEqual(["SIGKILL"]);
  });

  test("output caps: long streams truncate to a noted tail", async () => {
    const { adapter } = sb(
      { maxOutputBytes: 1_024 },
      { behavior: { stdout: "a".repeat(99_999) + "Z", stderr: "e".repeat(2_048) } },
    );
    const r = await Effect.runPromise(adapter.run("cat", ["/dev/big"]));
    expect(r.stdout).toStartWith("[truncated: showing last 1024 of 100000 bytes]\n");
    expect(r.stdout).toEndWith("Z");
    expect(r.stdout.length).toBeLessThan(1_024 + 100);
    expect(r.stderr).toStartWith("[truncated: showing last 1024 of 2048 bytes]\n");
  });

  test("output within the cap is untouched", async () => {
    const { adapter } = sb({ maxOutputBytes: 1_024 }, { behavior: { stdout: "small" } });
    const r = await Effect.runPromise(adapter.run("echo", ["small"]));
    expect(r.stdout).toBe("small");
  });

  test("readFile / writeFile roundtrip via sandbox.fs", async () => {
    const { adapter } = sb();
    await Effect.runPromise(adapter.writeFile("/out/result.json", '{"ok":true}'));
    const read = await Effect.runPromise(adapter.readFile("/out/result.json"));
    expect(read).toBe('{"ok":true}');
  });

  test("readFile on a missing path fails with a SandboxError carrying op/path", async () => {
    const { adapter } = sb();
    const r = await Effect.runPromise(Effect.either(adapter.readFile("/nope.txt")));
    expect(r._tag).toBe("Left");
    if (r._tag === "Left") {
      expect(r.left._tag).toBe("SandboxError");
      expect(r.left.op).toBe("read");
      expect(r.left.path).toBe("/nope.txt");
    }
  });

  test("readdir lists entry names", async () => {
    const { adapter } = sb({}, { files: { "/out/a.csv": "1", "/out/b.csv": "2", "/tmp/x": "" } });
    const names = await Effect.runPromise(adapter.readdir("/out"));
    expect([...names].toSorted()).toEqual(["a.csv", "b.csv"]);
  });

  test("run failure surfaces as SandboxError with op exec", async () => {
    const { adapter } = sb({}, { behavior: { startError: new Error("vm exploded") } });
    const r = await Effect.runPromise(Effect.either(adapter.run("true", [])));
    expect(r._tag).toBe("Left");
    if (r._tag === "Left") {
      expect(r.left._tag).toBe("SandboxError");
      expect(r.left.op).toBe("exec");
      expect(r.left.message).toContain("vm exploded");
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
    const first = await Effect.runPromise(Effect.either(adapter.writeFile("/tmp/a", "1")));
    expect(first._tag).toBe("Left");

    await Effect.runPromise(adapter.writeFile("/tmp/a", "1"));
    expect(state.getOrCreateCalls.length).toBe(2);
  });

  test("stop(): stops the VM; next op re-acquires (snapshot resume)", async () => {
    const { adapter, state } = sb();
    await Effect.runPromise(adapter.writeFile("/tmp/keep.txt", "v1"));
    await Effect.runPromise(adapter.stop());
    expect(state.stops).toBe(1);

    const read = await Effect.runPromise(adapter.readFile("/tmp/keep.txt"));
    expect(read).toBe("v1");
    expect(state.getOrCreateCalls.length).toBe(2);
  });

  test("stop() before any op is a no-op; repeated stop is safe", async () => {
    const { adapter, state } = sb();
    await Effect.runPromise(adapter.stop());
    await Effect.runPromise(adapter.stop());
    expect(state.stops).toBe(0);
    expect(state.getOrCreateCalls.length).toBe(0);
  });

  test("resolvePath: pure posix join against the VM namespace", () => {
    const { adapter } = sb();
    expect(adapter.resolvePath("out/a.txt", "/vercel/sandbox")).toBe("/vercel/sandbox/out/a.txt");
    expect(adapter.resolvePath("/abs/b.txt", "/vercel/sandbox")).toBe("/abs/b.txt");
    expect(adapter.resolvePath("../up.txt", "/vercel/sandbox")).toBe("/vercel/up.txt");
  });

  test("assertPathAllowed always succeeds — the VM is the boundary", async () => {
    const { adapter } = sb();
    await Effect.runPromise(adapter.assertPathAllowed("/etc/passwd"));
  });
});
