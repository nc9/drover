// CI gates, runnable locally exactly as CI runs them.
//
//   bun scripts/ci.ts lint                      oxlint packages + scripts
//   bun scripts/ci.ts format [--base <ref>]     oxfmt --check on files changed since <ref>
//   bun scripts/ci.ts build                     tsc build of every package, dependency order
//   bun scripts/ci.ts typecheck                 tsgo --noEmit per workspace (needs build)
//   bun scripts/ci.ts pack [--out <dir>]        pack every package, verify workspace dep versions
//   bun scripts/ci.ts test [--only a,b] [--skip a,b]   bun test per package + scripts/test (needs build)
//   bun scripts/ci.ts all                       every gate above, in that order
//
// Gates run sequentially and stop at the first failing gate; within a gate
// every package runs and the failures are listed at the end.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import {
  PACK_INDEX,
  PACKAGE_ORDER,
  isPrivatePackage,
  publishOrder,
  REPO_ROOT,
  orderProblems,
  packageDir,
  readManifest,
  staleWorkspaceDeps,
  workspaceVersions,
  type Manifest,
  type PackEntry,
} from "./workspace.ts";

type Result = { ok: boolean; stdout: string; stderr: string };

const exec = (cmd: readonly string[], cwd = REPO_ROOT, capture = false): Result => {
  const p = Bun.spawnSync([...cmd], {
    cwd,
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  return {
    ok: p.exitCode === 0,
    stdout: capture ? (p.stdout?.toString() ?? "") : "",
    stderr: capture ? (p.stderr?.toString() ?? "") : "",
  };
};

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const report = (gate: string, failures: readonly string[]): void => {
  if (failures.length > 0) fail(`${gate} failed: ${failures.join(", ")}`);
  console.log(`✓ ${gate} ok`);
};

const flag = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const listFlag = (args: readonly string[], name: string): string[] =>
  (flag(args, name) ?? "").split(",").filter((s) => s.length > 0);

// --- gates ---------------------------------------------------------------

const lint = (): void =>
  report("lint", exec(["bunx", "oxlint", "packages", "scripts"]).ok ? [] : ["oxlint"]);

// oxfmt formats these; anything else in a diff is ignored.
const FORMAT_EXTS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".yml",
  ".yaml",
]);

const ZERO_SHA = /^0+$/;

// The repo is not fully oxfmt-formatted, so CI checks only the files a change
// touches: `--base <ref>` (PR base sha, push "before" sha), defaulting to the
// merge-base with origin/main.
const format = (args: readonly string[]): void => {
  const given = flag(args, "--base");
  if (given !== undefined && (given === "" || ZERO_SHA.test(given))) {
    console.log("↷ format: no base commit (new branch push), nothing to compare");
    return;
  }
  const base =
    given ?? exec(["git", "merge-base", "origin/main", "HEAD"], REPO_ROOT, true).stdout.trim();
  if (base === "") fail("format: could not resolve a base commit (pass --base <ref>)");
  // A force-push can leave the push "before" sha outside the fetched history.
  if (!exec(["git", "cat-file", "-e", `${base}^{commit}`], REPO_ROOT, true).ok) {
    fail(`format: base ${base} is not in the local history (force push?); rerun with --base <ref>`);
  }
  const diff = exec(
    ["git", "diff", "--name-only", "--diff-filter=d", `${base}...HEAD`],
    REPO_ROOT,
    true,
  );
  if (!diff.ok) fail(`format: git diff against ${base} failed: ${diff.stderr.trim()}`);
  const files = diff.stdout
    .split("\n")
    .filter((f) => f !== "" && FORMAT_EXTS.has(extname(f)) && existsSync(join(REPO_ROOT, f)));
  if (files.length === 0) {
    console.log("✓ format ok (no formattable files changed)");
    return;
  }
  console.log(`▶ oxfmt --check on ${files.length} changed file(s) since ${base.slice(0, 12)}`);
  report("format", exec(["bunx", "oxfmt", "--check", ...files]).ok ? [] : ["oxfmt --check"]);
};

const assertOrder = (): void => {
  const problems = orderProblems();
  if (problems.length > 0) fail(`package order:\n  ${problems.join("\n  ")}`);
};

const build = (): void => {
  assertOrder();
  const failures = PACKAGE_ORDER.filter((pkg) => {
    console.log(`── build ${pkg}`);
    rmSync(join(packageDir(pkg), "dist"), { recursive: true, force: true });
    return !exec(["bun", "run", "build"], packageDir(pkg)).ok;
  });
  report("build", failures);
};

const hasScript = (dir: string, script: string): boolean =>
  existsSync(join(dir, "package.json")) && readManifest(dir).scripts?.[script] !== undefined;

// packages/*, evals, apps/* (each with a typecheck script) and the repo scripts.
const typecheckDirs = (): string[] => [
  ...PACKAGE_ORDER.map((p) => `packages/${p}`),
  "evals",
  "scripts",
  ...readdirSync(join(REPO_ROOT, "apps")).map((a) => `apps/${a}`),
];

const typecheck = (): void => {
  const failures = typecheckDirs()
    .filter((d) => d === "scripts" || hasScript(join(REPO_ROOT, d), "typecheck"))
    .filter((d) => {
      console.log(`── typecheck ${d}`);
      return !exec(["bunx", "tsgo", "--noEmit"], join(REPO_ROOT, d)).ok;
    });
  report("typecheck", failures);
};

// bun pm pack rewrites `workspace:*` from the versions recorded in bun.lock,
// not package.json. A stale lock would publish manifests that depend on old,
// possibly never-published versions, so verify every packed manifest.
const pack = (args: readonly string[]): void => {
  assertOrder();
  const keep = flag(args, "--out");
  const out = keep ? resolve(keep) : mkdtempSync(join(tmpdir(), "drover-pack-"));
  mkdirSync(out, { recursive: true });
  const versions = workspaceVersions();
  // One entry per package: the verified tarball, or undefined on failure.
  for (const pkg of PACKAGE_ORDER.filter(isPrivatePackage))
    console.log(`↷ not packed: ${pkg} is private (never published)`);
  const results = publishOrder().map((pkg): [string, PackEntry | undefined] => {
    const packed = exec(
      ["bun", "pm", "pack", "--quiet", "--destination", out],
      packageDir(pkg),
      true,
    );
    const tarball = packed.stdout.trim().split("\n").at(-1)?.trim() ?? "";
    if (!packed.ok || tarball === "") {
      console.error(`✗ pack failed: ${pkg}\n${packed.stdout}${packed.stderr}`);
      return [pkg, undefined];
    }
    const tgz = tarball.startsWith("/") ? tarball : join(out, tarball);
    const raw = exec(["tar", "-xzOf", tgz, "package/package.json"], REPO_ROOT, true);
    if (!raw.ok) {
      console.error(`✗ could not read package.json from ${tgz}: ${raw.stderr}`);
      return [pkg, undefined];
    }
    const manifest = JSON.parse(raw.stdout) as Manifest;
    const stale = staleWorkspaceDeps(manifest, versions);
    if (stale.length > 0) {
      console.error(`✗ stale workspace deps in packed ${pkg}: ${stale.join(", ")}`);
      return [pkg, undefined];
    }
    console.log(`✓ packed ${pkg} -> ${tgz}`);
    return [pkg, { pkg, name: manifest.name, version: manifest.version, tarball: basename(tgz) }];
  });
  const failures = results.filter(([, e]) => e === undefined).map(([pkg]) => pkg);
  // --out keeps the tarballs plus index.json (publish order) for scripts/release.ts.
  if (keep && failures.length === 0) {
    const entries = results.flatMap(([, e]) => (e ? [e] : []));
    writeFileSync(join(out, PACK_INDEX), `${JSON.stringify(entries, null, 2)}\n`);
  }
  if (!keep) rmSync(out, { recursive: true, force: true });
  if (failures.length > 0) {
    console.error(
      "  bun.lock is out of sync with package.json versions: bun publish would ship\n" +
        "  manifests depending on old versions. Plain `bun install` does NOT refresh\n" +
        "  workspace versions in bun.lock; run `bun scripts/release-bump.ts` or\n" +
        "  regenerate the lock (rm bun.lock && bun install).",
    );
  }
  report("pack", failures);
};

const testDir = (t: string): string =>
  t === "scripts" ? join(REPO_ROOT, "scripts") : packageDir(t);

const test = (args: readonly string[]): void => {
  const only = listFlag(args, "--only");
  const skip = listFlag(args, "--skip");
  // "scripts" = the repo tooling tests in scripts/test (release helpers).
  const targets = [...PACKAGE_ORDER, "scripts"];
  const unknown = [...only, ...skip].filter((p) => !targets.includes(p));
  if (unknown.length > 0) fail(`test: unknown package(s): ${unknown.join(", ")}`);
  const failures = targets
    .filter((p) => only.length === 0 || only.includes(p))
    .filter((p) => !skip.includes(p))
    .filter((p) => p === "scripts" || hasScript(packageDir(p), "test"))
    .filter((p) => {
      console.log(`── test ${p}`);
      const cmd = p === "scripts" ? ["bun", "test", "./test/"] : ["bun", "test"];
      return !exec(cmd, testDir(p)).ok;
    });
  report("test", failures);
};

const GATES: Record<string, (args: readonly string[]) => void> = {
  lint,
  format,
  build,
  typecheck,
  pack,
  test,
};

const main = (argv: readonly string[]): void => {
  const [gate, ...rest] = argv;
  if (gate === "all") {
    for (const g of ["lint", "format", "build", "typecheck", "pack", "test"]) GATES[g]?.(rest);
    return;
  }
  const run = gate === undefined ? undefined : GATES[gate];
  if (!run) fail(`usage: bun scripts/ci.ts <${[...Object.keys(GATES), "all"].join("|")}> [flags]`);
  run?.(rest);
};

if (import.meta.main) main(Bun.argv.slice(2));
