import { describe, expect, test } from "bun:test";

import {
  publishEntries,
  publishedVersions,
  type NpmResult,
  type PublishDeps,
} from "../release-publish.ts";
import type { PackEntry } from "../workspace.ts";

const ok = (stdout = ""): NpmResult => ({ code: 0, stdout, stderr: "" });
const e404 = (): NpmResult => ({ code: 1, stdout: "", stderr: "npm error code E404" });

type Pkg = { versions: string[]; tags: Record<string, string> };

/** An in-memory registry behind a fake `npm`, shaped like npm's real outputs. */
const fakeRegistry = (seed: Record<string, Pkg>, opts: { distTagRmFails?: boolean } = {}) => {
  const reg: Record<string, Pkg> = structuredClone(seed);
  const calls: string[] = [];
  const npm = (args: readonly string[]): NpmResult => {
    calls.push(args.join(" "));
    const [cmd, a, b] = args;
    if (cmd === "view") {
      const at = a!.lastIndexOf("@");
      const [name, version] = at > 0 ? [a!.slice(0, at), a!.slice(at + 1)] : [a!, undefined];
      const p = reg[name];
      if (!p) return e404();
      if (version !== undefined) return ok(p.versions.includes(version) ? `${version}\n` : "");
      if (b === "versions")
        return ok(JSON.stringify(p.versions.length === 1 ? p.versions[0] : p.versions));
      if (b === "dist-tags.latest") return ok(p.tags.latest ? `${p.tags.latest}\n` : "");
      if (b === "version") return ok(p.tags.latest ? `${p.tags.latest}\n` : "");
    }
    if (cmd === "dist-tag" && a === "rm") {
      if (opts.distTagRmFails) return { code: 1, stdout: "", stderr: "npm error code ENEEDAUTH" };
      delete reg[args[2]!]!.tags[args[3]!];
      return ok();
    }
    return { code: 1, stdout: "", stderr: `unexpected npm ${args.join(" ")}` };
  };
  const npmLoud = (args: readonly string[]): number => {
    calls.push(args.join(" "));
    // publish ./<scope>-<name>-<version>.tgz --access public --tag <tag> ...
    const tarball = args[1]!;
    const tag = args[args.indexOf("--tag") + 1]!;
    const entry = byTarball.get(tarball)!;
    if (args.includes("--dry-run")) return 0;
    const p = (reg[entry.name] ??= { versions: [], tags: {} });
    p.versions.push(entry.version);
    // The registry gives a package's first version `latest`, whatever --tag says.
    if (p.versions.length === 1) p.tags.latest = entry.version;
    p.tags[tag] = entry.version;
    return 0;
  };
  const byTarball = new Map<string, PackEntry>();
  return { reg, calls, npm, npmLoud, byTarball };
};

const entry = (name: string, version: string): PackEntry => ({
  pkg: name.replace(/^@droveragent\//, ""),
  name,
  version,
  tarball: `${name.replace("@", "").replace("/", "-")}-${version}.tgz`,
});

const run = (
  fake: ReturnType<typeof fakeRegistry>,
  entries: PackEntry[],
  dryRun = false,
): { counts: { published: number; skipped: number }; summary: string[] } => {
  for (const e of entries) fake.byTarball.set(`./${e.tarball}`, e);
  const summary: string[] = [];
  const deps: PublishDeps = {
    npm: fake.npm,
    npmLoud: fake.npmLoud,
    summary: (l) => summary.push(l),
    log: () => {},
    fail: (m) => {
      throw new Error(m);
    },
    dryRun,
  };
  return { counts: publishEntries(deps, entries, ["--provenance"]), summary };
};

describe("release publish re-runs", () => {
  test("first publish of a prerelease: latest is removed after publishing", () => {
    const fake = fakeRegistry({});
    const { counts } = run(fake, [entry("@droveragent/new", "0.3.0-next.1")]);
    expect(counts).toEqual({ published: 1, skipped: 0 });
    expect(fake.reg["@droveragent/new"]!.tags).toEqual({ next: "0.3.0-next.1" });
  });

  test("a re-run that skips a prerelease still removes a leftover prerelease latest", () => {
    // First run published but the dist-tag rm failed (no token): latest stayed on the prerelease.
    const fake = fakeRegistry({
      "@droveragent/new": {
        versions: ["0.3.0-next.1"],
        tags: { latest: "0.3.0-next.1", next: "0.3.0-next.1" },
      },
    });
    const { counts, summary } = run(fake, [entry("@droveragent/new", "0.3.0-next.1")]);
    expect(counts).toEqual({ published: 0, skipped: 1 });
    expect(fake.reg["@droveragent/new"]!.tags.latest).toBeUndefined();
    expect(summary.join("\n")).toContain("removed latest -> 0.3.0-next.1");
  });

  test("a skipped prerelease leaves a stable latest alone", () => {
    const fake = fakeRegistry({
      "@droveragent/core": {
        versions: ["0.1.0", "0.3.0-next.1"],
        tags: { latest: "0.1.0", next: "0.3.0-next.1" },
      },
    });
    run(fake, [entry("@droveragent/core", "0.3.0-next.1")]);
    expect(fake.reg["@droveragent/core"]!.tags.latest).toBe("0.1.0");
    expect(fake.calls).not.toContain("dist-tag rm @droveragent/core latest");
  });

  test("a failed dist-tag rm is a loud warning that names the token requirement, not a failure", () => {
    const fake = fakeRegistry({}, { distTagRmFails: true });
    const { counts, summary } = run(fake, [entry("@droveragent/new", "0.3.0-next.1")]);
    expect(counts.published).toBe(1);
    expect(summary.join("\n")).toMatch(/latest still -> 0\.3\.0-next\.1.*needs an npm token/s);
  });

  test("an existing package whose latest was removed is not mistaken for a first publish", () => {
    // `npm view <name> version` would be empty here (no latest); `versions` is not.
    const fake = fakeRegistry({
      "@droveragent/new": { versions: ["0.3.0-next.1"], tags: { next: "0.3.0-next.1" } },
    });
    const deps = {
      npm: fake.npm,
      fail: (m: string): never => {
        throw new Error(m);
      },
    } as unknown as PublishDeps;
    expect(publishedVersions(deps, "@droveragent/new")).toEqual(["0.3.0-next.1"]);
    expect(publishedVersions(deps, "@droveragent/absent")).toEqual([]);
    const { summary } = run(fake, [entry("@droveragent/new", "0.3.0-next.2")], true);
    expect(summary.join("\n")).not.toContain("is new");
  });

  test("a stable release keeps latest and never removes it", () => {
    const fake = fakeRegistry({
      "@droveragent/core": { versions: ["0.2.0"], tags: { latest: "0.2.0" } },
    });
    run(fake, [entry("@droveragent/core", "0.3.0")]);
    expect(fake.reg["@droveragent/core"]!.tags.latest).toBe("0.3.0");
    expect(fake.calls.some((c) => c.startsWith("dist-tag rm"))).toBe(false);
  });

  test("a registry error that is not a 404 aborts", () => {
    const fake = fakeRegistry({});
    const broken = {
      ...fake,
      npm: (): NpmResult => ({ code: 1, stdout: "", stderr: "ETIMEDOUT" }),
    };
    expect(() => run(broken, [entry("@droveragent/core", "0.3.0")])).toThrow(/not a 404/);
  });
});
