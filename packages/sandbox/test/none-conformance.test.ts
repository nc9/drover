import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createNoneSandbox, sandboxConformanceCases } from "../src/index.ts";
import type { SandboxConformanceSubject } from "../src/index.ts";

const make = (allowShell: boolean) => async (): Promise<SandboxConformanceSubject> => {
  const workdir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "drover-conf-")));
  return {
    adapter: createNoneSandbox({ allowedRoots: [workdir], allowShell }),
    workdir,
    cleanup: () => fs.rm(workdir, { recursive: true, force: true }),
  };
};

for (const allowShell of [false, true]) {
  describe(`none adapter conformance (allowShell=${allowShell})`, () => {
    for (const c of sandboxConformanceCases({ expectShell: allowShell })) {
      test(c.name, async () => {
        const subject = await make(allowShell)();
        try {
          await c.run(subject);
        } finally {
          await subject.cleanup?.();
        }
      });
    }
  });
}

describe("conformance suite self-check", () => {
  test("a wrong shell expectation is reported as a failure", async () => {
    const { runSandboxConformance } = await import("../src/index.ts");
    const results = await runSandboxConformance(make(false), { expectShell: true });
    expect(results.filter((r) => !r.ok).map((r) => r.name)).toEqual([
      "declares a boolean shell capability matching the expectation",
    ]);
  });

  test("a throwing factory is reported per case, not thrown", async () => {
    const { runSandboxConformance } = await import("../src/index.ts");
    const results = await runSandboxConformance(
      () => {
        throw new Error("no sandbox");
      },
      { expectShell: false },
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => !r.ok && r.error === "factory threw: no sandbox")).toBe(true);
  });

  test("a throwing cleanup does not hide the case result", async () => {
    const { runSandboxConformance } = await import("../src/index.ts");
    const base = make(false);
    const results = await runSandboxConformance(
      async () => {
        const subject = await base();
        return {
          ...subject,
          cleanup: async () => {
            await subject.cleanup?.();
            throw new Error("teardown");
          },
        };
      },
      { expectShell: true },
    );
    const shell = results.find((r) => r.name.startsWith("declares a boolean shell"));
    expect(shell?.ok).toBe(false);
    expect(shell?.error).toMatch(/^capabilities\.shell.*; cleanup threw: teardown$/);
    expect(results.every((r) => r.error?.endsWith("cleanup threw: teardown"))).toBe(true);
  });
});
