import { describe, expect, test } from "bun:test";
import {
  changelogSection,
  distTagFor,
  hasChangelogSection,
  isValidVersion,
  lockWorkspaces,
  setLockWorkspaceVersions,
  setManifestVersion,
} from "../release-lib.ts";
import { staleWorkspaceDeps } from "../workspace.ts";

const CHANGELOG = `# Changelog

## 0.3.0-next.1 — 2026-11-20

### Fixed

- provider errors fail the run

## 0.2.0 — 2026-08-25

Harness + facade only.

## 0.1.0

First release.
`;

const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "droveragent-monorepo",
    },
    "packages/core": {
      "name": "@droveragent/core",
      "version": "0.1.0",
      "dependencies": {
        "effect": "^3.10.0",
      },
    },
    "packages/harness": {
      "name": "@droveragent/harness",
      "version": "0.2.0",
    },
  },
  "packages": {
    "effect": ["effect@3.10.0", "", {}, "sha512-x"],
  }
}
`;

describe("versions", () => {
  test("semver validation", () => {
    for (const ok of ["0.3.0", "0.3.0-next.1", "1.0.0-rc.0", "10.20.30"]) {
      expect(isValidVersion(ok)).toBe(true);
    }
    for (const bad of ["v0.3.0", "0.3", "0.3.0-", "01.0.0", "0.3.0\nx=1", "0.3.0+build"]) {
      expect(isValidVersion(bad)).toBe(false);
    }
  });

  test("prereleases go to next, never latest", () => {
    expect(distTagFor("0.3.0-next.1")).toBe("next");
    expect(distTagFor("0.3.0-rc.1")).toBe("next");
    expect(distTagFor("0.3.0")).toBe("latest");
  });
});

describe("changelog", () => {
  test("finds a section by exact version", () => {
    expect(hasChangelogSection(CHANGELOG, "0.3.0-next.1")).toBe(true);
    expect(hasChangelogSection(CHANGELOG, "0.1.0")).toBe(true);
    expect(hasChangelogSection(CHANGELOG, "0.3.0")).toBe(false);
    expect(hasChangelogSection(CHANGELOG, "0.3.0-next.2")).toBe(false);
    expect(hasChangelogSection(CHANGELOG, "0.2")).toBe(false);
  });

  test("dots are literal, not regex wildcards", () => {
    expect(hasChangelogSection("## 0x3y0\n", "0.3.0")).toBe(false);
  });

  test("extracts the section body up to the next heading", () => {
    expect(changelogSection(CHANGELOG, "0.3.0-next.1")).toBe(
      "### Fixed\n\n- provider errors fail the run",
    );
    expect(changelogSection(CHANGELOG, "0.1.0")).toBe("First release.");
    expect(changelogSection(CHANGELOG, "9.9.9")).toBeUndefined();
  });
});

describe("bun.lock workspace versions", () => {
  test("reads workspace entries", () => {
    expect(lockWorkspaces(LOCK)).toEqual([
      { dir: "core", name: "@droveragent/core", version: "0.1.0" },
      { dir: "harness", name: "@droveragent/harness", version: "0.2.0" },
    ]);
  });

  test("rewrites only the named workspaces", () => {
    const next = setLockWorkspaceVersions(LOCK, new Set(["core"]), "0.3.0-next.1");
    expect(lockWorkspaces(next).map((w) => w.version)).toEqual(["0.3.0-next.1", "0.2.0"]);
    expect(next).toContain('"effect": ["effect@3.10.0"');
    const all = setLockWorkspaceVersions(LOCK, new Set(["core", "harness"]), "0.3.0-next.1");
    expect(new Set(lockWorkspaces(all).map((w) => w.version))).toEqual(new Set(["0.3.0-next.1"]));
    expect(all.split("\n").length).toBe(LOCK.split("\n").length);
  });
});

describe("package.json version", () => {
  test("rewrites the top-level version only", () => {
    const text = `{\n  "name": "@droveragent/x",\n  "version": "0.1.0",\n  "dependencies": {\n    "y": "workspace:*"\n  }\n}\n`;
    expect(setManifestVersion(text, "0.3.0-next.1")).toBe(text.replace("0.1.0", "0.3.0-next.1"));
  });

  test("throws without a version field", () => {
    expect(() => setManifestVersion(`{\n  "name": "x"\n}\n`, "1.0.0")).toThrow();
  });
});

describe("pack check", () => {
  const versions = new Map([
    ["@droveragent/core", "0.3.0-next.1"],
    ["@droveragent/sandbox", "0.3.0-next.1"],
  ]);

  test("flags a stale or unrewritten workspace dep", () => {
    expect(
      staleWorkspaceDeps(
        {
          name: "@droveragent/tools",
          version: "0.3.0-next.1",
          dependencies: { "@droveragent/core": "0.1.0", effect: "^3.10.0" },
          peerDependencies: { "@droveragent/sandbox": "workspace:*" },
        },
        versions,
      ),
    ).toEqual([
      "@droveragent/core@0.1.0 (workspace has 0.3.0-next.1)",
      "@droveragent/sandbox@workspace:* (workspace has 0.3.0-next.1)",
    ]);
  });

  test("passes when every workspace dep matches", () => {
    expect(
      staleWorkspaceDeps(
        { name: "t", version: "1", dependencies: { "@droveragent/core": "0.3.0-next.1" } },
        versions,
      ),
    ).toEqual([]);
  });
});
