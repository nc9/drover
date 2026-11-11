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
  const marker = (): string => `drover-pg-${crypto.randomUUID()}`;
  const alive = (m: string): boolean =>
    Bun.spawnSync(["pgrep", "-f", m]).stdout.toString().trim() !== "";

  test("a timeout kills grandchildren too, keeps output and returns promptly", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "drover-pg-")));
    const m = marker();
    const sb = createNoneSandbox({ allowedRoots: [dir], allowShell: true });
    const started = Date.now();
    const r = await Effect.runPromise(
      sb.run("/bin/sh", ["-c", `echo before; sleep 30 & sleep 30; : ${m}`], {
        cwd: dir,
        timeoutMs: 300,
      }),
    );
    expect(r.killed).toBe(true);
    expect(r.stdout).toBe("before\n");
    expect(Date.now() - started).toBeLessThan(5_000);
    await Bun.sleep(100);
    expect(alive(m)).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("an exec still running when the host exits is killed with it", async () => {
    const m = marker();
    const script = `
      import { Effect } from "effect";
      import { createNoneSandbox } from ${JSON.stringify(path.join(import.meta.dir, "../src/index.ts"))};
      const sb = createNoneSandbox({ allowShell: true });
      void Effect.runPromise(sb.run("/bin/sh", ["-c", "sleep 30; : ${m}"], { timeoutMs: 60_000 }));
      setTimeout(() => process.exit(0), 300);
    `;
    const host = Bun.spawn([process.execPath, "-e", script], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await host.exited).toBe(0);
    await Bun.sleep(100);
    expect(alive(m)).toBe(false);
  });
});
