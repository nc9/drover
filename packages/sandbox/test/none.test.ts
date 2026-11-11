import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createNoneSandbox } from "../src/index.ts";

describe("createNoneSandbox", () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "drover-sb-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "drover-out-"));
    await fs.writeFile(path.join(root, "ok.txt"), "hello");
    await fs.writeFile(path.join(outside, "secret"), "hunter2");
    await fs.symlink(path.join(outside, "secret"), path.join(root, "link"));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  test("reads inside allowedRoots", async () => {
    const sandbox = createNoneSandbox({ allowedRoots: [root] });
    const out = await Effect.runPromise(sandbox.readFile(path.join(root, "ok.txt")));
    expect(out).toBe("hello");
  });

  test("blocks reads via symlink escape", async () => {
    const sandbox = createNoneSandbox({ allowedRoots: [root] });
    const r = await Effect.runPromise(Effect.either(sandbox.readFile(path.join(root, "link"))));
    expect(r._tag).toBe("Left");
  });

  test("blocks direct reads outside allowedRoots", async () => {
    const sandbox = createNoneSandbox({ allowedRoots: [root] });
    const r = await Effect.runPromise(
      Effect.either(sandbox.readFile(path.join(outside, "secret"))),
    );
    expect(r._tag).toBe("Left");
  });

  test("writes inside allowedRoots, even for new nested paths", async () => {
    const sandbox = createNoneSandbox({ allowedRoots: [root] });
    await Effect.runPromise(sandbox.writeFile(path.join(root, "new/nested/file.txt"), "x"));
    const written = await fs.readFile(path.join(root, "new/nested/file.txt"), "utf8");
    expect(written).toBe("x");
  });

  test("blocks writes outside allowedRoots", async () => {
    const sandbox = createNoneSandbox({ allowedRoots: [root] });
    const r = await Effect.runPromise(
      Effect.either(sandbox.writeFile(path.join(outside, "leaked"), "boom")),
    );
    expect(r._tag).toBe("Left");
  });

  test("assertPathAllowed accepts inside, rejects outside", async () => {
    const sandbox = createNoneSandbox({ allowedRoots: [root] });
    const ok = await Effect.runPromise(Effect.either(sandbox.assertPathAllowed(root)));
    expect(ok._tag).toBe("Right");
    const bad = await Effect.runPromise(Effect.either(sandbox.assertPathAllowed(outside)));
    expect(bad._tag).toBe("Left");
  });

  test("shell capability is false by default", () => {
    const sandbox = createNoneSandbox();
    expect(sandbox.capabilities.shell).toBe(false);
  });

  test("shell capability is true with allowShell", () => {
    const sandbox = createNoneSandbox({ allowShell: true });
    expect(sandbox.capabilities.shell).toBe(true);
  });

  test("empty allowedRoots allows anything (no boundary)", async () => {
    const sandbox = createNoneSandbox();
    const r = await Effect.runPromise(
      Effect.either(sandbox.readFile(path.join(outside, "secret"))),
    );
    expect(r._tag).toBe("Right");
  });
});

// Process-tree handling: execs run in their own process group (POSIX).
describe.skipIf(process.platform === "win32")("createNoneSandbox process groups", () => {
  // A unique `sleep` argument marks every process of one test, grandchildren included.
  const sleepArg = (): string => `20.${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
  const alive = (arg: string): boolean =>
    Bun.spawnSync(["pgrep", "-f", `sleep ${arg}`])
      .stdout.toString()
      .trim() !== "";
  const waitUntil = async (cond: () => boolean, ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cond()) return true;
      await Bun.sleep(50);
    }
    return cond();
  };
  const killAll = (arg: string): void => {
    Bun.spawnSync(["pkill", "-9", "-f", `sleep ${arg}`]);
  };

  const SRC = JSON.stringify(path.join(import.meta.dir, "../src/index.ts"));
  type Mode = "exit" | "wait" | "own-sigint";
  // A host process that starts one exec (two sleeps, one backgrounded), prints
  // "spawned" once both are running, then exits or waits for a signal. The
  // sleep argument goes in through the env, never the host's argv, so pgrep
  // matches only the sleeps and never the host itself.
  const startHost = (arg: string, mode: Mode) => {
    const script = `
      import { Effect } from "effect";
      import { createNoneSandbox } from ${SRC};
      ${mode === "own-sigint" ? `process.on("SIGINT", () => console.log("host-handled"));` : ""}
      const arg = process.env.DROVER_SLEEP_ARG;
      const sb = createNoneSandbox({ allowShell: true });
      void Effect.runPromise(
        sb.run("/bin/sh", ["-c", \`sleep \${arg} & sleep \${arg}; wait\`], { timeoutMs: 60_000 }),
      );
      const count = () =>
        Bun.spawnSync(["pgrep", "-f", \`sleep \${arg}\`]).stdout.toString().trim().split("\\n").filter(Boolean).length;
      while (count() < 2) await Bun.sleep(20);
      console.log("spawned");
      ${mode === "exit" ? "process.exit(0);" : "setInterval(() => {}, 1000);"}
    `;
    const host = Bun.spawn([process.execPath, "-e", script], {
      cwd: import.meta.dir,
      env: { ...process.env, DROVER_SLEEP_ARG: arg },
      stdout: "pipe",
      stderr: "pipe",
    });
    let out = "";
    const reader = host.stdout.getReader();
    const decoder = new TextDecoder();
    const readUntil = async (needle: string, ms = 10_000): Promise<string> => {
      const end = Date.now() + ms;
      while (!out.includes(needle) && Date.now() < end) {
        const chunk = await Promise.race([
          reader.read(),
          Bun.sleep(Math.max(0, end - Date.now())).then(() => ({ done: true, value: undefined })),
        ]);
        if (chunk.value) out += decoder.decode(chunk.value);
        if (chunk.done) break;
      }
      return out;
    };
    return { host, readUntil };
  };

  test("a timeout kills grandchildren too, keeps output and returns promptly", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "drover-pg-")));
    const arg = sleepArg();
    const sb = createNoneSandbox({ allowedRoots: [dir], allowShell: true });
    const started = Date.now();
    try {
      const r = await Effect.runPromise(
        sb.run("/bin/sh", ["-c", `echo before; sleep ${arg} & sleep ${arg}`], {
          cwd: dir,
          timeoutMs: 300,
        }),
      );
      expect(r.killed).toBe(true);
      expect(r.stdout).toBe("before\n");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await waitUntil(() => !alive(arg), 2_000)).toBe(true);
    } finally {
      killAll(arg);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("an exec still running when the host calls process.exit is killed with it", async () => {
    const arg = sleepArg();
    const { host, readUntil } = startHost(arg, "exit");
    try {
      expect(await readUntil("spawned")).toContain("spawned");
      expect(await host.exited).toBe(0);
      expect(await waitUntil(() => !alive(arg), 2_000)).toBe(true);
    } finally {
      host.kill("SIGKILL");
      killAll(arg);
    }
  });

  test("SIGTERM to the host kills the exec and the host still dies by SIGTERM (143)", async () => {
    const arg = sleepArg();
    const { host, readUntil } = startHost(arg, "wait");
    try {
      expect(await readUntil("spawned")).toContain("spawned");
      host.kill("SIGTERM");
      const code = await host.exited;
      expect(host.signalCode === "SIGTERM" || code === 143).toBe(true);
      expect(await waitUntil(() => !alive(arg), 2_000)).toBe(true);
    } finally {
      host.kill("SIGKILL");
      killAll(arg);
    }
  });

  test("a host with its own SIGINT handler is not killed by ours; the exec still is", async () => {
    const arg = sleepArg();
    const { host, readUntil } = startHost(arg, "own-sigint");
    try {
      expect(await readUntil("spawned")).toContain("spawned");
      host.kill("SIGINT");
      expect(await readUntil("host-handled")).toContain("host-handled");
      expect(await waitUntil(() => !alive(arg), 2_000)).toBe(true);
      await Bun.sleep(200);
      expect(host.exitCode).toBeNull();
      expect(host.signalCode).toBeNull();
    } finally {
      host.kill("SIGKILL");
      killAll(arg);
    }
  });
});
