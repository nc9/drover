/**
 * The shared SandboxAdapter conformance suite against `createVercelSandbox`, on a host-backed
 * client that executes every command and file operation (see host-backed-client.ts). Every case
 * runs; none is skipped.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runSandboxConformance, sandboxConformanceCases } from "@droveragent/sandbox";

import { createVercelSandbox } from "../src/index.ts";
import { hostBackedVercelClient } from "./host-backed-client.ts";

const subject = async () => {
  const workdir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "drover-vercel-")));
  const fake = hostBackedVercelClient();
  return {
    adapter: createVercelSandbox({ client: fake.client, killGraceMs: 500 }),
    workdir,
    cleanup: () => fs.rm(workdir, { recursive: true, force: true }),
  };
};

describe("vercel adapter conformance (host-backed client)", () => {
  for (const c of sandboxConformanceCases({ expectShell: true })) {
    test(c.name, async () => {
      const s = await subject();
      try {
        await c.run(s);
      } finally {
        await s.cleanup();
      }
    });
  }

  test("every case ran and passed (none skipped)", async () => {
    const results = await runSandboxConformance(subject, { expectShell: true });
    expect(results.length).toBe(sandboxConformanceCases({ expectShell: true }).length);
    expect(results.filter((r) => !r.ok)).toEqual([]);
  }, 30_000);
});
