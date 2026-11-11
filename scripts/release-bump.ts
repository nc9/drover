// Lockstep version bump: every packages/* member (and the `droveragent`
// umbrella) gets the same version, and bun.lock's workspace versions follow.
//
//   bun scripts/release-bump.ts <version> [--dry-run]
//
// Refuses when the version is not valid semver or CHANGELOG.md has no
// `## <version>` section. Steps:
//   1. set "version" in every packages/*/package.json
//   2. rewrite the workspace "version" fields in bun.lock (plain `bun install`,
//      even --frozen-lockfile, never refreshes them, and bun pm pack / bun
//      publish rewrite `workspace:*` from the lock, not package.json)
//   3. `bun install --frozen-lockfile` to confirm the lock is still consistent
//   4. verify every workspace version in bun.lock equals <version>
//   5. `bun scripts/ci.ts pack`: every packed manifest depends on <version>
// --dry-run prints the plan and writes nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  hasChangelogSection,
  isValidVersion,
  lockWorkspaces,
  setLockWorkspaceVersions,
  setManifestVersion,
} from "./release-lib.ts";
import { REPO_ROOT, packageDir, readManifest, workspacePackages } from "./workspace.ts";

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const run = (cmd: readonly string[]): void => {
  console.log(`$ ${cmd.join(" ")}`);
  const p = Bun.spawnSync([...cmd], { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) fail(`${cmd.join(" ")} exited ${p.exitCode}`);
};

const LOCK = join(REPO_ROOT, "bun.lock");

const main = (argv: readonly string[]): void => {
  const dryRun = argv.includes("--dry-run");
  const version = argv.find((a) => !a.startsWith("--"));
  if (version === undefined) fail("usage: bun scripts/release-bump.ts <version> [--dry-run]");
  const v = version as string;
  if (!isValidVersion(v)) fail(`not a valid semver version: ${v}`);

  const changelog = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  if (!hasChangelogSection(changelog, v)) {
    fail(`CHANGELOG.md has no "## ${v}" section; add the release notes first`);
  }

  const pkgs = workspacePackages();
  const lock = readFileSync(LOCK, "utf8");
  const lockDirs = new Set(lockWorkspaces(lock).map((w) => w.dir));
  const notInLock = pkgs.filter((p) => !lockDirs.has(p));
  if (notInLock.length > 0) {
    fail(`bun.lock has no workspace entry for: ${notInLock.join(", ")} (run bun install first)`);
  }

  for (const p of pkgs) {
    const m = readManifest(packageDir(p));
    console.log(`${dryRun ? "would bump" : "bump"} ${m.name} ${m.version} -> ${v}`);
  }
  if (dryRun) {
    console.log("↷ dry run: nothing written");
    return;
  }

  for (const p of pkgs) {
    const file = join(packageDir(p), "package.json");
    writeFileSync(file, setManifestVersion(readFileSync(file, "utf8"), v));
  }
  writeFileSync(LOCK, setLockWorkspaceVersions(lock, new Set(pkgs), v));

  run(["bun", "install", "--frozen-lockfile"]);

  const stale = lockWorkspaces(readFileSync(LOCK, "utf8"))
    .filter((w) => pkgs.includes(w.dir) && w.version !== v)
    .map((w) => `${w.name}@${w.version}`);
  if (stale.length > 0) fail(`bun.lock still carries: ${stale.join(", ")}`);
  console.log(`✓ bun.lock workspace versions all ${v}`);

  run(["bun", "scripts/ci.ts", "pack"]);
  console.log(`✓ bumped ${pkgs.length} packages to ${v}; review the diff and commit`);
};

if (import.meta.main) main(Bun.argv.slice(2));
