# Releasing

All `@droveragent/*` packages and the `droveragent` umbrella share one version
(lockstep). Prereleases such as `0.3.0-next.1` go to the npm `next` dist-tag and
never to `latest`; a plain `0.3.0` goes to `latest`.

Releases are published by `.github/workflows/release.yml` when a `v*` tag is
pushed, after an approval on the `npm-publish` environment. Nothing publishes
from a branch, a pull request or a dry run.

## One-time setup (repository owner)

Do these before pushing the first release tag.

1. **Create the `npm-publish` environment first.** Settings > Environments >
   New environment > `npm-publish`:
   - Required reviewers: the maintainers who approve releases.
   - Deployment branches and tags: "Selected branches and tags", add the tag
     rule `v*`.

   A workflow job that names an environment which does not exist yet creates it
   with no protection rules, so a tag pushed before this step would publish
   without an approval.

2. **Tag ruleset (required).** Settings > Rules > Rulesets > New tag ruleset:
   target `v*`, restrict creations, updates and deletions to the release
   maintainers (bypass list). Pushing a `v*` tag starts a release, so only the
   people who may approve one may create one.

3. **npm auth: `NPM_TOKEN` (required for `0.3.0-next.1`).** Create an npm
   granular access token with read and write access to the `@droveragent`
   scope and the `droveragent` package, allowed to bypass 2FA for publishing.
   Store it as the `NPM_TOKEN` secret **on the `npm-publish` environment**
   (not a repository secret), so only the approved publish job can read it.

   The token is required for the first train: `@droveragent/sandbox-cloudflare`,
   `@droveragent/storage-d1` and `droveragent` have never been published, and
   npm only lets you add a trusted publisher to a package that already exists.

4. **npm auth: trusted publishing (after `0.3.0-next.1`).** Once every package
   exists, add a trusted publisher to each one on npmjs.com (Package >
   Settings > Trusted Publisher > GitHub Actions):
   - Organization or user: `nc9`
   - Repository: `drover`
   - Workflow filename: `release.yml`
   - Environment name: `npm-publish`

   The workflow pins npm 11.18.0 (trusted publishing needs npm 11.5.1 or later)
   and grants `id-token: write` to the publish job only; npm uses OIDC where a
   trusted publisher is configured and the token elsewhere. When every package
   publishes through OIDC, set each package's publishing access to "Require
   two-factor authentication and disallow tokens" and delete `NPM_TOKEN`, but
   only once no package has a prerelease on `latest`: removing a dist-tag still
   needs a token (see "`dist-tag rm` needs a token" below).

5. **Package metadata (#32) must be merged before the first tag.** npm
   provenance rejects a manifest without
   `"repository": { "type": "git", "url": "git+https://github.com/nc9/drover.git", "directory": "packages/<dir>" }`
   (E422). The workflow checks every packed manifest: a tag run refuses, a
   dry run warns.

## Cutting a release

1. Land the release notes: a `## <version>` section in `CHANGELOG.md`, with
   the last PR of the release.
2. Bump every package on a branch:

   ```sh
   bun scripts/release-bump.ts 0.3.0-next.1 --dry-run   # show the plan
   bun scripts/release-bump.ts 0.3.0-next.1
   ```

   It refuses a dirty working tree, an invalid version, a version not greater
   than the highest current one, or a missing CHANGELOG section. It sets the
   version in every `packages/*/package.json`, rewrites the workspace versions
   in `bun.lock` (plain `bun install`, even `--frozen-lockfile`, never updates
   them, and `bun pm pack` reads them), runs `bun install --frozen-lockfile`,
   checks every workspace version in `bun.lock`, and runs the pack check.
   Commit as `chore(release): 0.3.0-next.1`, open a PR, merge when CI is green.

3. Tag the merge commit on `main` and push the tag:

   ```sh
   git tag v0.3.0-next.1 <merge sha>
   git push origin v0.3.0-next.1
   ```

4. The workflow runs `prepare`: it refuses unless every package is at the tag
   version, the CHANGELOG section exists and the commit is on `main`; then it
   builds, packs, verifies the packed manifests (workspace dep versions and
   the provenance `repository` field) and runs
   `npm publish --dry-run` for every package. Read its log, then approve the
   `npm-publish` deployment.
5. `publish` uploads the tarballs from `prepare` in dependency order with
   provenance, skipping only a name@version already on the registry and
   stopping at any other failure, then creates the GitHub Release from the
   CHANGELOG section (marked prerelease for a prerelease).
6. Check: `npm view @droveragent/core dist-tags`.

**A prerelease never stays on `latest`.** The npm registry gives a package's first
version the `latest` dist-tag whatever `--tag` says. After every prerelease the
workflow publishes, and for every prerelease a re-run skips as already published,
it reads `npm view <pkg> dist-tags.latest`; when that points at a prerelease it runs
`npm dist-tag rm <pkg> latest`. If the registry refuses (it may not let the only
`latest` go), the run summary says so, and `npm install <pkg>` resolves to that
prerelease until a stable version is published. A first publish is detected from
`npm view <pkg> versions` (empty or 404), not `version`, which is empty once
`latest` has been removed. For `0.3.0-next.1` this applies to
`@droveragent/sandbox-cloudflare`, `@droveragent/storage-d1` and `droveragent`.

**`dist-tag rm` needs a token.** npm trusted publishing (OIDC) authorises `npm
publish` only. Removing a dist-tag needs `NPM_TOKEN` on the `npm-publish`
environment. Keep the token while any package still has a prerelease on `latest`,
and when a brand-new package is first published as a prerelease after the token
was deleted, add a token back for that release, or remove the tag by hand
(`npm dist-tag rm <pkg> latest`) and re-run the job to confirm.

If `publish` fails part way, fix the cause and re-run the failed job: packages
already published are skipped, and a leftover prerelease `latest` is cleaned up on
the re-run.

## Dry run

- Every pull request that changes the release tooling runs the `prepare` job
  as a dry run.
- On demand: `gh workflow run release.yml --ref main` (dry run is the default).
  On a ref other than a `v*` tag, the lockstep and CHANGELOG checks only warn.
- Locally:

  ```sh
  bun scripts/ci.ts build
  bun scripts/ci.ts pack --out /tmp/drover-pack
  bun scripts/release.ts plan --ref refs/heads/main
  bun scripts/release.ts verify --dir /tmp/drover-pack --ref refs/heads/main
  bun scripts/release.ts publish --dir /tmp/drover-pack --dry-run
  ```

## Laptop fallback

`scripts/publish-all.sh` publishes the same packages in the same order with
`bun publish` (no provenance). Use it only when the workflow cannot run, and
never for a version the workflow is publishing.
