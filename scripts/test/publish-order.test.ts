import { describe, expect, test } from "bun:test";

import { publishEntries, type NpmResult, type PublishDeps } from "../release-publish.ts";
import { PACKAGE_ORDER, isPrivatePackage, publishOrder, type PackEntry } from "../workspace.ts";

const printOrder = (args: string[]): string[] => {
  const p = Bun.spawnSync(["bun", `${import.meta.dir}/../workspace.ts`, ...args]);
  expect(p.exitCode).toBe(0);
  return p.stdout.toString().trim().split("\n");
};

describe("private packages are never packed for publish or published", () => {
  test("publishOrder drops private packages and keeps the order of the rest", () => {
    const order = ["core", "secret", "facade", "umbrella"];
    const priv = new Set(["secret", "umbrella"]);
    expect(publishOrder(order, (p) => priv.has(p))).toEqual(["core", "facade"]);
  });

  test("the umbrella publishes as @droveragent/all: no package is private, publish order = build order", () => {
    expect(isPrivatePackage("droveragent")).toBe(false);
    expect(PACKAGE_ORDER).toContain("droveragent");
    expect(publishOrder()).toEqual([...PACKAGE_ORDER]);
  });

  test("bun scripts/workspace.ts --publish prints the publish order; plain prints the build order", () => {
    expect(printOrder(["--publish"])).toEqual(publishOrder());
    expect(printOrder([])).toEqual([...PACKAGE_ORDER]);
  });

  test("publishEntries never sends a private entry to npm, in a real or a dry run", () => {
    for (const dryRun of [false, true]) {
      const calls: string[] = [];
      const summary: string[] = [];
      const npm = (args: readonly string[]): NpmResult => {
        calls.push(args.join(" "));
        return { code: 1, stdout: "", stderr: "npm error code E404" };
      };
      const entries: PackEntry[] = [
        { pkg: "core", name: "@droveragent/core", version: "0.3.0", tarball: "core.tgz" },
        { pkg: "secret", name: "@droveragent/secret", version: "0.3.0", tarball: "secret.tgz" },
      ];
      const deps: PublishDeps = {
        npm,
        npmLoud: (args) => {
          calls.push(args.join(" "));
          return 0;
        },
        summary: (l) => summary.push(l),
        log: () => {},
        fail: (m) => {
          throw new Error(m);
        },
        dryRun,
        isPrivate: (e) => e.pkg === "secret",
      };
      const counts = publishEntries(deps, entries, ["--provenance"]);
      expect(counts).toEqual({ published: 1, skipped: 1 });
      expect(
        calls.filter((c) => c.includes("secret.tgz") || c.includes("@droveragent/secret")),
      ).toEqual([]);
      expect(calls.some((c) => c.startsWith("publish ./core.tgz"))).toBe(true);
      expect(summary.join("\n")).toContain("SKIP @droveragent/secret@0.3.0: private package");
    }
  });
});
