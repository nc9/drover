/**
 * Post-build: stamp the package version into dist/version.js (cwd = the package dir).
 *
 * - `DROVER_RELEASE=1` (set by the release workflow and scripts/publish-all.sh): the plain
 *   package.json version, so a published tarball says e.g. `0.3.0`.
 * - Any other build: `<version>+local.<short git sha>[.dirty]` (`+local` without git), so a
 *   consumer linked to a working tree can tell it is not running a release.
 *
 * `scripts/release.ts verify` refuses a release whose tarballs carry anything but the plain version.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The literal every package's src/version.ts ships with (see packages/x/src/version.ts). */
export const UNSTAMPED = 'export const version = "source";';

export const stampedVersion = (version: string, release: boolean, sha: string | null): string =>
  release ? version : `${version}+local${sha ? `.${sha}` : ""}`;

// Short HEAD sha, with ".dirty" when the working tree has uncommitted changes.
const gitSha = (cwd: string): string | null => {
  const r = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd });
  const out = r.exitCode === 0 ? r.stdout.toString().trim() : "";
  if (!/^[0-9a-f]{4,40}$/.test(out)) return null;
  const st = Bun.spawnSync(["git", "status", "--porcelain"], { cwd });
  return st.exitCode === 0 && st.stdout.toString().trim() !== "" ? `${out}.dirty` : out;
};

export function stampVersion(pkgDir: string, distDir = join(pkgDir, "dist")): string {
  const file = join(distDir, "version.js");
  if (!existsSync(file)) {
    throw new Error(`postbuild-version: ${file} is missing (every package has src/version.ts)`);
  }
  const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    version: string;
  };
  const stamped = stampedVersion(version, process.env.DROVER_RELEASE === "1", gitSha(pkgDir));
  const src = readFileSync(file, "utf8");
  if (!src.includes(UNSTAMPED)) {
    throw new Error(`postbuild-version: ${file} does not contain ${UNSTAMPED}`);
  }
  writeFileSync(file, src.replace(UNSTAMPED, `export const version = ${JSON.stringify(stamped)};`));
  return stamped;
}

if (import.meta.main) console.log(`postbuild-version: ${stampVersion(process.cwd())}`);
