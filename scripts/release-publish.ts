// The publish loop of scripts/release.ts, with npm injected so the re-run paths are
// testable without a registry (scripts/test/release-publish.test.ts).
import { distTagFor, isPrerelease } from "./release-lib.ts";
import type { PackEntry } from "./workspace.ts";

export type NpmResult = { code: number; stdout: string; stderr: string };

export interface PublishDeps {
  /** Runs `npm <args>` (in the pack dir) and captures its output. */
  npm: (args: readonly string[]) => NpmResult;
  /** Runs `npm <args>` with output streamed to the log; returns the exit code. */
  npmLoud: (args: readonly string[]) => number;
  /** A line for the log and the job summary. */
  summary: (line: string) => void;
  log: (line: string) => void;
  fail: (msg: string) => never;
  dryRun: boolean;
  /**
   * Whether an entry is a private package (`"private": true` in its packed manifest).
   * A private entry is never checked against or sent to the registry. Default: none are.
   */
  isPrivate?: (entry: PackEntry) => boolean;
}

const is404 = (r: NpmResult): boolean => /E404/.test(`${r.stdout}\n${r.stderr}`);

/**
 * Whether `name@version` is on the registry. Mirrors scripts/publish-all.sh: success with
 * non-empty stdout is published; an E404 (or empty stdout) is missing; anything else aborts.
 */
export const versionPublished = (deps: PublishDeps, name: string, version: string): boolean => {
  const spec = `${name}@${version}`;
  const r = deps.npm(["view", spec, "version"]);
  if (r.code === 0 && r.stdout.trim() !== "") return true;
  if (r.code === 0 || is404(r)) return false;
  return deps.fail(`registry check failed for ${spec} (not a 404):\n${r.stdout}${r.stderr}`);
};

/**
 * Every version the registry has for `name` ([] when the package does not exist). Uses
 * `versions`, not `version`: `version` is the `latest` tag's version and is empty once
 * `latest` has been removed, which would make an existing package look new.
 */
export const publishedVersions = (deps: PublishDeps, name: string): string[] => {
  const r = deps.npm(["view", name, "versions", "--json"]);
  if (r.code !== 0) {
    if (is404(r)) return [];
    return deps.fail(`registry check failed for ${name} (not a 404):\n${r.stdout}${r.stderr}`);
  }
  const text = r.stdout.trim();
  if (text === "") return [];
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
};

/** The version on the `latest` dist-tag, or undefined when there is none. */
export const latestTag = (deps: PublishDeps, name: string): string | undefined => {
  const r = deps.npm(["view", name, "dist-tags.latest"]);
  if (r.code !== 0) {
    if (is404(r)) return undefined;
    return deps.fail(`dist-tag check failed for ${name} (not a 404):\n${r.stdout}${r.stderr}`);
  }
  const v = r.stdout.trim();
  return v === "" ? undefined : v;
};

/**
 * A prerelease must never sit on `latest`. The registry gives a package's first version
 * `latest` whatever `--tag` says, so after publishing (or skipping, on a re-run) a
 * prerelease, look at `latest` and remove it when it points at a prerelease. `dist-tag rm`
 * needs a token (OIDC trusted publishing covers `publish` only); a refusal is a loud warning,
 * not a failure.
 */
export const clearPrereleaseLatest = (deps: PublishDeps, name: string): void => {
  const latest = latestTag(deps, name);
  if (latest === undefined || !isPrerelease(latest)) return;
  if (deps.dryRun) {
    deps.summary(
      `ℹ ${name}: latest -> ${latest} (a prerelease); a real run would try \`npm dist-tag rm ${name} latest\``,
    );
    return;
  }
  const rm = deps.npm(["dist-tag", "rm", name, "latest"]);
  if (rm.code === 0) {
    deps.summary(`✓ ${name}: removed latest -> ${latest} (a prerelease)`);
    return;
  }
  deps.summary(
    `⚠ ${name}: latest still -> ${latest}, a prerelease (dist-tag rm failed: ${rm.stderr.trim().split("\n").at(-1) ?? ""}). ` +
      `\`npm install ${name}\` resolves to it until a stable version is published. ` +
      "Removing a dist-tag needs an npm token (see RELEASING.md).",
  );
};

/** Publish every entry in order; skip versions already on the registry; fail fast otherwise. */
export const publishEntries = (
  deps: PublishDeps,
  entries: readonly PackEntry[],
  extraPublishArgs: readonly string[],
): { published: number; skipped: number } => {
  const counts = { published: 0, skipped: 0 };
  for (const e of entries) {
    const spec = `${e.name}@${e.version}`;
    if (deps.isPrivate?.(e) === true) {
      deps.summary(`↷ SKIP ${spec}: private package, never published`);
      counts.skipped += 1;
      continue;
    }
    const tag = distTagFor(e.version);
    if (versionPublished(deps, e.name, e.version)) {
      deps.log(`↷ SKIP ${spec}: exact version already on registry`);
      counts.skipped += 1;
      // A re-run after a partial publish (or a failed dist-tag rm) retries the cleanup.
      if (tag !== "latest") clearPrereleaseLatest(deps, e.name);
      continue;
    }
    const firstPublish = publishedVersions(deps, e.name).length === 0;
    deps.log(
      `── ${deps.dryRun ? "dry-run publishing" : "publishing"} ${spec} (dist-tag ${tag}${firstPublish ? ", first version of the package" : ""})`,
    );
    const code = deps.npmLoud([
      "publish",
      `./${e.tarball}`,
      "--access",
      "public",
      "--tag",
      tag,
      ...(deps.dryRun ? ["--dry-run"] : extraPublishArgs),
    ]);
    if (code !== 0) deps.fail(`publish FAILED: ${spec}; aborting, later packages NOT published`);
    counts.published += 1;
    if (tag !== "latest") {
      if (deps.dryRun && firstPublish) {
        deps.summary(
          `ℹ ${e.name} is new: a real run would also try \`npm dist-tag rm ${e.name} latest\``,
        );
      } else clearPrereleaseLatest(deps, e.name);
    }
  }
  return counts;
};
