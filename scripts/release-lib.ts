// Pure helpers shared by scripts/release-bump.ts and scripts/release.ts.
// No I/O here, so scripts/test/release-lib.test.ts covers them directly.

// SemVer 2.0.0 without build metadata (npm ignores it; we never use it).
const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export const isValidVersion = (v: string): boolean => VERSION_RE.test(v);

export const isPrerelease = (v: string): boolean => v.includes("-");

// Prereleases (0.3.0-next.1, 0.3.0-rc.1, ...) never go to `latest`.
export const distTagFor = (v: string): "next" | "latest" => (isPrerelease(v) ? "next" : "latest");

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `## <version>` heading, optionally followed by a date or title
// (`## 0.2.0 — 2026-08-25`). `## 0.3.0` does not match `## 0.3.0-next.1`.
const headingRe = (version: string): RegExp =>
  new RegExp(`^## ${escapeRe(version)}(?=$|[ \\t])`, "m");

export const hasChangelogSection = (changelog: string, version: string): boolean =>
  headingRe(version).test(changelog);

// The body of the `## <version>` section (heading excluded), up to the next
// `## ` heading. Undefined when there is no such section.
export const changelogSection = (changelog: string, version: string): string | undefined => {
  const m = headingRe(version).exec(changelog);
  if (!m) return undefined;
  const afterHeading = changelog.indexOf("\n", m.index);
  if (afterHeading === -1) return "";
  const rest = changelog.slice(afterHeading + 1);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
};

// bun.lock workspace entries look like
//   "packages/core": {
//     "name": "@droveragent/core",
//     "version": "0.1.0",
// Plain `bun install` (even --frozen-lockfile) never refreshes these, and
// bun pm pack / bun publish rewrite `workspace:*` from them, so the bump
// rewrites them directly.
const LOCK_WORKSPACE_RE =
  /("packages\/([^"]+)": \{\s*"name": "([^"]+)",\s*"version": ")([^"]*)(")/g;

export type LockWorkspace = { dir: string; name: string; version: string };

export const lockWorkspaces = (lock: string): LockWorkspace[] =>
  [...lock.matchAll(LOCK_WORKSPACE_RE)].map((m) => ({
    dir: m[2] ?? "",
    name: m[3] ?? "",
    version: m[4] ?? "",
  }));

export const setLockWorkspaceVersions = (
  lock: string,
  dirs: ReadonlySet<string>,
  version: string,
): string =>
  lock.replace(
    LOCK_WORKSPACE_RE,
    (whole, pre: string, dir: string, _n: string, _v: string, post: string) =>
      dirs.has(dir) ? `${pre}${version}${post}` : whole,
  );

// Rewrites only the top-level "version" field, keeping the file's formatting.
export const setManifestVersion = (manifestText: string, version: string): string => {
  const re = /^(\s{2}"version":\s*")([^"]*)(")/m;
  if (!re.test(manifestText)) throw new Error("package.json has no top-level version field");
  return manifestText.replace(re, `$1${version}$3`);
};
