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
import { changelogSection, distTagFor, isPrerelease, isValidVersion } from "./release-lib.ts";
import {
  PACK_INDEX,
  PACKAGE_ORDER,
  REPO_ROOT,
  packageDir,
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
  const versions = PACKAGE_ORDER.map((p) => [p, readManifest(packageDir(p)).version] as const);
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

type Registry = "published" | "missing";

// Mirrors scripts/publish-all.sh: require success AND non-empty stdout to
// call it published; an E404 is "missing"; anything else aborts.
const registryState = (spec: string, cwd: string): Registry => {
  const r = exec(["npm", "view", spec, "version"], cwd, true);
  if (r.code === 0 && r.stdout.trim() !== "") return "published";
  if (r.code === 0 || /E404/.test(`${r.stdout}\n${r.stderr}`)) return "missing";
  return fail(`registry check failed for ${spec} (not a 404):\n${r.stdout}${r.stderr}`);
};

const publish = (args: readonly string[]): void => {
  const dir = resolve(flag(args, "--dir") ?? fail("publish: --dir <pack dir> is required"));
  const dryRun = args.includes("--dry-run");
  const entries = JSON.parse(readFileSync(join(dir, PACK_INDEX), "utf8")) as PackEntry[];
  const order = entries.map((e) => e.pkg).join(",");
  if (order !== PACKAGE_ORDER.join(",")) fail(`${PACK_INDEX} order does not match PACKAGE_ORDER`);

  const counts = { published: 0, skipped: 0 };
  for (const e of entries) {
    const spec = `${e.name}@${e.version}`;
    if (registryState(spec, dir) === "published") {
      console.log(`↷ SKIP ${spec}: exact version already on registry`);
      counts.skipped += 1;
      continue;
    }
    const tag = distTagFor(e.version);
    console.log(`── ${dryRun ? "dry-run publishing" : "publishing"} ${spec} (dist-tag ${tag})`);
    // cwd = the pack dir, outside the repo: the repo .npmrc expects NPM_TOKEN,
    // which is unset under trusted publishing.
    const cmd = [
      "npm",
      "publish",
      `./${e.tarball}`,
      "--access",
      "public",
      "--tag",
      tag,
      ...(dryRun ? ["--dry-run"] : ["--provenance"]),
    ];
    if (exec(cmd, dir, false).code !== 0) {
      fail(`publish FAILED: ${spec}; aborting, later packages NOT published`);
    }
    counts.published += 1;
  }
  const verb = dryRun ? "would publish" : "published";
  console.log(
    `✓ done: ${counts.published} ${verb}, ${counts.skipped} skipped (already on registry)`,
  );
};

const COMMANDS: Record<string, (args: readonly string[]) => void> = { plan, publish };

const main = (argv: readonly string[]): void => {
  const [cmd, ...rest] = argv;
  const run = cmd === undefined ? undefined : COMMANDS[cmd];
  if (!run) fail("usage: bun scripts/release.ts <plan|publish> [flags]");
  run?.(rest);
};

if (import.meta.main) main(Bun.argv.slice(2));
