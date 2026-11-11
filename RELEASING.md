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

2. **npm auth: trusted publishing (preferred).** For each package on
   npmjs.com (Package > Settings > Trusted Publisher > GitHub Actions):
   - Organization or user: `nc9`
   - Repository: `drover`
   - Workflow filename: `release.yml`
   - Environment name: `npm-publish`

   The workflow pins npm 11.18.0 (trusted publishing needs npm 11.5.1 or later)
   and grants `id-token: write` to the publish job only. Trusted publishing
   also produces provenance automatically. Once every package works with it,
   set each package's publishing access to "Require two-factor authentication
   and disallow tokens".

   A package that has never been published cannot have a trusted publisher
   yet: publish its first version with the token below (or
   `scripts/publish-all.sh`), then add the trusted publisher.

3. **npm auth: token fallback.** Create an npm granular access token with
   read and write access to the `@droveragent` scope and the `droveragent`
   package, allowed to bypass 2FA for publishing. Store it as the
   `NPM_TOKEN` secret **on the `npm-publish` environment** (not a repository
   secret), so only the approved publish job can read it. Packages with a
   trusted publisher use OIDC; the token covers the rest.
4. Optional: a tag ruleset restricting who can create `v*` tags.

## Cutting a release

1. Land the release notes: a `## <version>` section in `CHANGELOG.md`, with
   the last PR of the release.
2. Bump every package on a branch:

   ```sh
   bun scripts/release-bump.ts 0.3.0-next.1 --dry-run   # show the plan
   bun scripts/release-bump.ts 0.3.0-next.1
   ```

   It refuses an invalid version or a missing CHANGELOG section, sets the
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
   builds, packs, verifies the packed manifests and runs
   `npm publish --dry-run` for every package. Read its log, then approve the
   `npm-publish` deployment.
5. `publish` uploads the tarballs from `prepare` in dependency order with
   provenance, skipping only a name@version already on the registry and
   stopping at any other failure, then creates the GitHub Release from the
   CHANGELOG section (marked prerelease for a prerelease).
6. Check: `npm view @droveragent/core dist-tags`.

If `publish` fails part way, fix the cause and re-run the failed job: packages
already published are skipped.

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
  bun scripts/release.ts publish --dir /tmp/drover-pack --dry-run
  ```

## Laptop fallback

`scripts/publish-all.sh` publishes the same packages in the same order with
`bun publish` (no provenance). Use it only when the workflow cannot run, and
never for a version the workflow is publishing.
