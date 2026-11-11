/**
 * The shared SandboxAdapter conformance suite against `createCloudflareSandbox`, on a
 * host-backed client that executes every command and file operation (see
 * host-backed-client.ts). Every case runs; none is skipped.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runSandboxConformance, sandboxConformanceCases } from "@droveragent/sandbox";
import { Effect } from "effect";

import { createCloudflareSandbox } from "../src/index.ts";
import { hostBackedCloudflareClient } from "./host-backed-client.ts";

const subject = async () => {
  const workdir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "drover-cf-")));
  const fake = hostBackedCloudflareClient();
  return {
    adapter: createCloudflareSandbox({
      name: "conformance",
      client: fake.client,
      cwd: workdir,
      allowedRoots: [workdir],
      killGraceMs: 500,
    }),
    workdir,
    cleanup: () => fs.rm(workdir, { recursive: true, force: true }),
    fake,
  };
};

describe("cloudflare adapter conformance (host-backed client)", () => {
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

  test("every case ran and passed (none skipped); deny-all egress was applied", async () => {
    const results = await runSandboxConformance(subject, { expectShell: true });
    expect(results.length).toBe(sandboxConformanceCases({ expectShell: true }).length);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    const s = await subject();
    try {
      // Any operation acquires the sandbox, which applies the network policy.
      await Effect.runPromise(s.adapter.writeFile(`${s.workdir}/x.txt`, "x"));
      expect(s.fake.egress).toEqual({ allowed: [], denied: [] });
    } finally {
      await s.cleanup();
    }
  }, 30_000);
});
