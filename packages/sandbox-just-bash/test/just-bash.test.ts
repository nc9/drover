import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createJustBashSandbox } from "../src/index.ts";

let rwRoot: string;
let roRoot: string;

beforeAll(async () => {
  rwRoot = await fs.mkdtemp(path.join(os.tmpdir(), "drover-jb-rw-"));
  roRoot = await fs.mkdtemp(path.join(os.tmpdir(), "drover-jb-ro-"));
  await fs.writeFile(path.join(rwRoot, "hello.txt"), "from-rw\n");
  await fs.writeFile(path.join(roRoot, "secret.txt"), "from-ro\n");
});

afterAll(async () => {
  await fs.rm(rwRoot, { recursive: true, force: true });
  await fs.rm(roRoot, { recursive: true, force: true });
});

describe("createJustBashSandbox", () => {
  test("shell capability is unconditionally true", () => {
    expect(createJustBashSandbox().capabilities.shell).toBe(true);
  });

  test("id defaults to just-bash and is overridable", () => {
    expect(createJustBashSandbox().id).toBe("just-bash");
    expect(createJustBashSandbox({ id: "jb-1" }).id).toBe("jb-1");
  });

  test("run: echoes to stdout with exit 0", async () => {
    const sb = createJustBashSandbox();
    const r = await Effect.runPromise(sb.run("echo", ["hi there"]));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hi there\n");
  });

  test("run: /bin/sh -c executes a multi-statement script", async () => {
    const sb = createJustBashSandbox();
    const r = await Effect.runPromise(sb.run("/bin/sh", ["-c", 'x=5; echo "val=$x"']));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("val=5\n");
  });

  test("run: argv bypasses shell parsing — args with spaces survive", async () => {
    const sb = createJustBashSandbox({ files: { "/d/a.txt": "needle here\n" } });
    const r = await Effect.runPromise(sb.run("grep", ["-RnE", "needle here", "/d"]));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("/d/a.txt:1:needle here");
  });

  test("run: grep / find / ls over seeded files", async () => {
    const sb = createJustBashSandbox({
      files: { "/d/a.txt": "alpha\nbeta\n", "/d/b.md": "beta\n" },
    });
    const grep = await Effect.runPromise(sb.run("grep", ["-RnE", "--include=*.txt", "beta", "/d"]));
    expect(grep.stdout).toBe("/d/a.txt:2:beta\n");

    const find = await Effect.runPromise(sb.run("find", ["/d", "-type", "f", "-name", "*.md"]));
    expect(find.stdout).toBe("/d/b.md\n");

    const ls = await Effect.runPromise(sb.run("ls", ["-1", "/d"]));
    expect(ls.stdout.split("\n").filter(Boolean).toSorted()).toEqual(["a.txt", "b.md"]);
  });

  test("readFile / writeFile roundtrip; FS persists across calls", async () => {
    const sb = createJustBashSandbox();
    await Effect.runPromise(sb.writeFile("/nested/deep/f.txt", "payload"));
    const direct = await Effect.runPromise(sb.readFile("/nested/deep/f.txt"));
    expect(direct).toBe("payload");
    const viaRun = await Effect.runPromise(sb.run("cat", ["/nested/deep/f.txt"]));
    expect(viaRun.stdout).toBe("payload");
  });

  test("readFile on an unmounted path fails (no host access)", async () => {
    const sb = createJustBashSandbox();
    const r = await Effect.runPromise(Effect.either(sb.readFile("/etc/hosts")));
    expect(r._tag).toBe("Left");
  });

  test("readwrite mount: writes land on the host", async () => {
    const sb = createJustBashSandbox({
      mounts: [{ source: rwRoot, target: "/work", mode: "readwrite" }],
    });
    const read = await Effect.runPromise(sb.readFile("/work/hello.txt"));
    expect(read).toBe("from-rw\n");

    await Effect.runPromise(sb.writeFile("/work/created.txt", "new-content"));
    expect(await fs.readFile(path.join(rwRoot, "created.txt"), "utf8")).toBe("new-content");
  });

  test("readonly mount: reads pass through, writes are rejected", async () => {
    const sb = createJustBashSandbox({
      mounts: [{ source: roRoot, target: "/ref", mode: "readonly" }],
    });
    const read = await Effect.runPromise(sb.readFile("/ref/secret.txt"));
    expect(read).toBe("from-ro\n");

    const write = await Effect.runPromise(
      Effect.either(sb.writeFile("/ref/secret.txt", "tampered")),
    );
    expect(write._tag).toBe("Left");
    expect(await fs.readFile(path.join(roRoot, "secret.txt"), "utf8")).toBe("from-ro\n");
  });

  test("mount is escape-proof: ../ traversal cannot reach outside the root", async () => {
    const sb = createJustBashSandbox({
      mounts: [{ source: rwRoot, target: "/work", mode: "readwrite" }],
    });
    const r = await Effect.runPromise(sb.run("/bin/sh", ["-c", "cat /work/../../../../etc/hosts"]));
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe("");
  });

  test("timeoutMs: a slow command is killed", async () => {
    const sb = createJustBashSandbox();
    const r = await Effect.runPromise(
      sb.run("/bin/sh", ["-c", "sleep 5; echo done"], { timeoutMs: 200 }),
    );
    expect(r.killed).toBe(true);
    expect(r.stdout).not.toContain("done");
  });

  test("an already-aborted signal kills the run", async () => {
    const sb = createJustBashSandbox();
    const ac = new AbortController();
    ac.abort();
    const r = await Effect.runPromise(sb.run("echo", ["hi"], { signal: ac.signal }));
    expect(r.killed).toBe(true);
  });

  test("python: enabled via the python flag", async () => {
    const sb = createJustBashSandbox({ python: true });
    const r = await Effect.runPromise(sb.run("/bin/sh", ["-c", "python3 -c 'print(1 + 2)'"]));
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("3");
  });
});
