// Release steps run by .github/workflows/release.yml (also runnable locally).
//
//   bun scripts/release.ts plan --ref <git ref> [--notes <file>]
//     Resolves the version, dist-tag and release notes. On a `refs/tags/v*`
//     ref it REFUSES unless: the tag is valid semver, every package is at
//     exactly that version (lockstep), CHANGELOG.md has its section and the
//     tagged commit is on origin/main. On any other ref (dry run) those are
//     warnings. Writes version / dist_tag / prerelease / is_tag to
//     $GITHUB_OUTPUT when set.
//
//   bun scripts/release.ts verify --dir <dir> --ref <git ref>
//     Every packed manifest must carry repository { url, directory } matching
//     this repo, or npm provenance fails with E422. Refuses on a tag ref.
//
//   Packages with `"private": true` (scripts/workspace.ts publishOrder) are
//   left out of every step: not lockstep-checked, not packed, not published.
//
//   bun scripts/release.ts publish --dir <dir> [--dry-run]
//     Publishes the tarballs from `bun scripts/ci.ts pack --out <dir>` with npm
//     in dependency order (index.json). Skips a name@version only when the
//     registry verifiably has it; any other failure aborts, so later packages
//     are not attempted. Real runs add --provenance. Dist-tag: `next` for a
//     prerelease, `latest` otherwise. --dry-run uses `npm publish --dry-run`.
//
// npm (not bun publish) does the publishing: bun publish has no provenance or
// OIDC trusted publishing. The tarballs come from bun pm pack, which rewrites
// `workspace:*`; npm publish of a package dir would not.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  changelogSection,
  distTagFor,
  isPrerelease,
  isValidVersion,
  repositoryProblem,
} from "./release-lib.ts";
import { publishEntries } from "./release-publish.ts";
import {
  PACK_INDEX,
  PACKAGE_ORDER,
  REPO_ROOT,
  isPrivatePackage,
  packageDir,
  publishOrder,
  readManifest,
  type PackEntry,
} from "./workspace.ts";

type Result = { code: number; stdout: string; stderr: string };

const exec = (cmd: readonly string[], cwd: string, capture: boolean): Result => {
  const p = Bun.spawnSync([...cmd], {
    cwd,
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  return {
    code: p.exitCode ?? 1,
    stdout: capture ? (p.stdout?.toString() ?? "") : "",
    stderr: capture ? (p.stderr?.toString() ?? "") : "",
  };
};

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const flag = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const TAG_PREFIX = "refs/tags/v";

// --- plan ----------------------------------------------------------------

const plan = (args: readonly string[]): void => {
  const ref = flag(args, "--ref") ?? fail("plan: --ref <git ref> is required");
  const isTag = ref.startsWith(TAG_PREFIX);
  const versions = publishOrder().map((p) => [p, readManifest(packageDir(p)).version] as const);
  const unpublished = PACKAGE_ORDER.filter(isPrivatePackage);
  if (unpublished.length > 0) console.log(`ℹ private, not released: ${unpublished.join(", ")}`);
  const version = isTag ? ref.slice(TAG_PREFIX.length) : (versions[0]?.[1] ?? "");

  // Tag runs refuse on any problem; dry runs report and continue.
  const problem = (msg: string): void => {
    if (isTag) fail(msg);
    console.warn(`⚠ (dry run, a tag would refuse) ${msg}`);
  };

  if (!isValidVersion(version)) fail(`not a valid semver version: ${version}`);
  const off = versions.filter(([, v]) => v !== version).map(([p, v]) => `${p}@${v}`);
  if (off.length > 0) {
    problem(`not lockstep at ${version}: ${off.join(", ")} (run bun scripts/release-bump.ts)`);
  }
  const notes = changelogSection(readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8"), version);
  if (notes === undefined) problem(`CHANGELOG.md has no "## ${version}" section`);
  if (isTag) {
    const onMain = exec(
      ["git", "merge-base", "--is-ancestor", "HEAD", "origin/main"],
      REPO_ROOT,
      true,
    );
    if (onMain.code !== 0) fail(`tagged commit is not on origin/main`);
  }

  const distTag = distTagFor(version);
  const notesFile = flag(args, "--notes");
  if (notesFile) {
    mkdirSync(dirname(resolve(notesFile)), { recursive: true });
    writeFileSync(resolve(notesFile), `${notes ?? ""}\n`);
  }
  const out = {
    version,
    dist_tag: distTag,
    prerelease: String(isPrerelease(version)),
    is_tag: String(isTag),
  };
  console.log(`release plan: ${JSON.stringify(out)}`);
  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut) {
    appendFileSync(
      ghOut,
      Object.entries(out)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(""),
    );
  }
};

// --- publish ---------------------------------------------------------------

const readIndex = (dir: string): PackEntry[] => {
  const entries = JSON.parse(readFileSync(join(dir, PACK_INDEX), "utf8")) as PackEntry[];
  const priv = entries.filter((e) => isPrivatePackage(e.pkg)).map((e) => e.pkg);
  if (priv.length > 0) fail(`${PACK_INDEX} lists private package(s) ${priv.join(", ")}: repack`);
  const order = entries.map((e) => e.pkg).join(",");
  if (order !== publishOrder().join(",")) {
    fail(
      `${PACK_INDEX} order does not match the publish order (PACKAGE_ORDER without private packages)`,
    );
  }
  return entries;
};

// Shown on the workflow run page as well as in the log.
const summary = (line: string): void => {
  console.log(line);
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${line}\n`);
};

// Repository problems in the packed manifests (npm provenance rejects a
// missing or mismatched repository with E422).
const repositoryProblems = (dir: string, entries: readonly PackEntry[]): string[] =>
  entries.flatMap((e) => {
    const raw = exec(["tar", "-xzOf", join(dir, e.tarball), "package/package.json"], dir, true);
    if (raw.code !== 0) return [`${e.pkg}: cannot read package.json from ${e.tarball}`];
    const problem = repositoryProblem(JSON.parse(raw.stdout) as { repository?: unknown }, e.pkg);
    return problem ? [problem] : [];
  });

//   bun scripts/release.ts verify --dir <pack dir> --ref <git ref>
// Tag refs refuse on any problem; other refs (dry runs) warn.
const verify = (args: readonly string[]): void => {
  const dir = resolve(flag(args, "--dir") ?? fail("verify: --dir <pack dir> is required"));
  const ref = flag(args, "--ref") ?? fail("verify: --ref <git ref> is required");
  const problems = repositoryProblems(dir, readIndex(dir));
  if (problems.length === 0) {
    console.log("✓ every packed manifest has the provenance repository field");
    return;
  }
  const text = `packed manifests not publishable with provenance:\n  ${problems.join("\n  ")}`;
  if (ref.startsWith(TAG_PREFIX)) fail(text);
  summary(`⚠ (dry run, a tag would refuse) ${text}`);
};

const publish = (args: readonly string[]): void => {
  const dir = resolve(flag(args, "--dir") ?? fail("publish: --dir <pack dir> is required"));
  const dryRun = args.includes("--dry-run");
  const entries = readIndex(dir);
  if (!dryRun) {
    const problems = repositoryProblems(dir, entries);
    if (problems.length > 0) fail(`refusing to publish:\n  ${problems.join("\n  ")}`);
  }

  // cwd = the pack dir, outside the repo: the repo .npmrc expects NPM_TOKEN,
  // which is unset under trusted publishing.
  const counts = publishEntries(
    {
      npm: (a) => exec(["npm", ...a], dir, true),
      npmLoud: (a) => exec(["npm", ...a], dir, false).code,
      summary,
      log: (line) => console.log(line),
      fail,
      dryRun,
      // The packed manifest decides: a tarball marked private is never sent to npm.
      isPrivate: (e) => {
        const raw = exec(["tar", "-xzOf", join(dir, e.tarball), "package/package.json"], dir, true);
        if (raw.code !== 0) return fail(`${e.pkg}: cannot read package.json from ${e.tarball}`);
        return (JSON.parse(raw.stdout) as { private?: unknown }).private === true;
      },
    },
    entries,
    ["--provenance"],
  );
  const verb = dryRun ? "would publish" : "published";
  console.log(
    `✓ done: ${counts.published} ${verb}, ${counts.skipped} skipped (already on registry)`,
  );
};

const COMMANDS: Record<string, (args: readonly string[]) => void> = { plan, verify, publish };

const main = (argv: readonly string[]): void => {
  const [cmd, ...rest] = argv;
  const run = cmd === undefined ? undefined : COMMANDS[cmd];
  if (!run) fail("usage: bun scripts/release.ts <plan|verify|publish> [flags]");
  run?.(rest);
};

if (import.meta.main) main(Bun.argv.slice(2));
