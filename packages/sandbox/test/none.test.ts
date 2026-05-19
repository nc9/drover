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
    const r = await Effect.runPromise(
      Effect.either(sandbox.readFile(path.join(root, "link"))),
    );
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
    await Effect.runPromise(
      sandbox.writeFile(path.join(root, "new/nested/file.txt"), "x"),
    );
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
    const ok = await Effect.runPromise(
      Effect.either(sandbox.assertPathAllowed(root)),
    );
    expect(ok._tag).toBe("Right");
    const bad = await Effect.runPromise(
      Effect.either(sandbox.assertPathAllowed(outside)),
    );
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
