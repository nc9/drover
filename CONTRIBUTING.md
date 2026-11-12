# Contributing to drover

Thanks for helping. Drover is a Bun workspace of TypeScript packages under `packages/`.

## Setup

```bash
git clone https://github.com/nc9/drover.git
cd drover
bun install
```

Packages resolve each other through `dist`, so build the packages you depend on once (`cd packages/<pkg> && bunx tsc -p tsconfig.build.json && bun run ../../scripts/postbuild-dts.ts`) before typechecking a dependent package.

## Local gates

CI (`.github/workflows/ci.yml`) runs `scripts/ci.ts`, one gate per step. Run the same gates locally, in this order (build before typecheck and test: packages resolve each other through `dist/`):

```bash
bun install --frozen-lockfile
bun scripts/ci.ts lint        # oxlint packages scripts
bun scripts/ci.ts format      # oxfmt --check on files changed since origin/main (committed)
bun scripts/ci.ts build       # tsc build of every package, dependency order
bun scripts/ci.ts typecheck   # tsgo --noEmit per workspace, sequential
bun scripts/ci.ts pack        # pack each package, fail on stale bun.lock workspace versions
bun scripts/ci.ts test        # bun test per package (--only a,b / --skip a,b)
```

`bun scripts/ci.ts all` runs every gate. The package build order lives in `scripts/workspace.ts`; a new package must be added there (CI fails until it is).

While iterating on one package, the narrow versions are faster:

```bash
# typecheck one package (never the whole repo at once)
cd packages/<pkg> && ../../node_modules/.bin/tsgo --noEmit

# lint and format only your changed files
bunx oxlint <changed files>
bunx oxfmt <changed files>

# tests: explicit file paths, from the package dir, a few at a time
cd packages/<pkg> && bun test test/foo.test.ts test/bar.test.ts
```

The repo is not fully oxfmt-formatted yet, so CI checks only the files a PR changes, and `oxfmt` on a directory reformats far more than your change. Format the files you touch.

## Commits

Use `type(scope): message #issue`, for example `fix(harness): retry output decode once #123`.

- Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `style`, `chore`, `revert`, `hotfix`.
- Scope is required and is usually the package name.
- One branch per issue, branched from `main`.

### Sign-off (DCO)

Every commit must carry a `Signed-off-by` line. Add it with `git commit -s` (or `git commit --amend -s` to fix the last commit, `git rebase --signoff main` for a branch). Signing off certifies the [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change, or otherwise have the right to submit it, under this project's MIT licence. Use your real name and an email you can be reached at.

## Conventions

- TypeScript only. File names are lowercase with hyphens.
- Functional style: pure functions and plain data. No classes for agents, plugins or tools.
- Schemas are TypeBox. Anything that sits on an `AgentSpec` must be JSON-serialisable.
- Errors and services use Effect idioms (`Data.TaggedError`, `Layer`).
- Tests inject dependencies (a fake `streamFn`, fake adapters). No `mock.module`, no process-wide patches, no live provider or network calls, no real secrets.
- A user-facing change updates `docs/**/*.mdx` (and `docs/docs.json` for a new page) and the package README if it has one.
- Do not edit `CHANGELOG.md` or bump versions in a feature PR; put a changelog line in the PR description.

## Docs

```bash
bun x tangly build --root docs --out dist --base /drover/
```

## Developing a consumer against a local build

A consumer app that needs unreleased Drover changes should run against a **pinned, built copy** of Drover, never the checkout you are editing: rebuilding `dist/` in a linked checkout changes the code under a running consumer.

### 1. Build a pinned copy

```bash
git -C ~/src/drover worktree add ../drover-pinned <commit or branch>
cd ~/src/drover-pinned
bun install --frozen-lockfile
bun scripts/ci.ts build
```

Rebuild it only when the consumer is stopped, and only when you mean to move the consumer to new code.

### 2a. Tarballs (recommended: survives an install)

```bash
cd ~/src/drover-pinned
bun scripts/ci.ts pack --out ~/src/drover-tarballs
```

`pack --out` keeps one `.tgz` per package with `workspace:*` already rewritten to real versions. In the consumer's `package.json`, point every Drover package at its tarball, both as a dependency and as an override, so transitive `@droveragent/*` deps resolve to the tarballs too:

```json
{
  "dependencies": {
    "@droveragent/all": "file:../drover-tarballs/droveragent-all-<version>.tgz"
  },
  "overrides": {
    "@droveragent/core": "file:../drover-tarballs/droveragent-core-<version>.tgz",
    "@droveragent/facade": "file:../drover-tarballs/droveragent-facade-<version>.tgz"
  }
}
```

List every `@droveragent/*` package the consumer pulls in (the umbrella pulls in most of them; `index.json` in the tarball directory lists them all, and an override for a package the consumer does not use is harmless). Then `bun install`. Because the tarball paths are in `package.json`, a later `bun install` keeps them.

### 2b. bun link (quick, fragile)

```bash
cd ~/src/drover-pinned/packages/droveragent && bun link   # repeat for each package you use
cd ~/src/my-app && bun link droveragent @droveragent/core ...
```

A plain `bun install` in the consumer **drops these links** and puts the npm release back, silently. A long-running job can then import the published version mid-run. Re-run `bun link <names>` after every install, or use `bun link <name> --save`, which writes `link:<name>` into `package.json` so the link survives an install.

### 3. Verify which build the consumer loads

```bash
cd ~/src/my-app
ls -l node_modules/droveragent node_modules/@droveragent      # links point at drover-pinned
bun -e 'console.log(Bun.resolveSync("@droveragent/all", process.cwd()))'
grep '"@droveragent/core": \["' bun.lock                      # tarball route: @droveragent/core@../drover-tarballs/...
```

Run the check after every `bun install` in the consumer. From inside the consumer, one call prints what is actually loaded:

```ts
import { droverVersions } from "@droveragent/all"; // also exported by @droveragent/core and @droveragent/facade

console.log(droverVersions());
// { "@droveragent/core": "0.3.0+local.1a2b3c4", "@droveragent/harness": "0.3.0+local.1a2b3c4", ... }
```

Every package registers its version when its main entry is loaded. A published release reports the plain version (`0.3.0`). Any build from a working tree reports `<version>+local.<git sha>`, with `.dirty` when the tree had uncommitted changes, so a consumer that fell back to the npm release shows plain versions where you expected `+local`. A package listed with two versions (`"0.3.0, 0.3.0+local.1a2b3c4"`) is loaded twice, a linked build next to an installed one.

The stamp is written into `dist/version.js` at build time (`scripts/postbuild-version.ts`). Release builds set `DROVER_RELEASE=1` (the release workflow and `scripts/publish-all.sh` do), and `scripts/release.ts verify` refuses a release whose tarballs carry a `+local` stamp.

### 4. Go back to the published release

Remove the `file:` entries and overrides (tarballs) or run `bun unlink` in each linked package and `bun remove` the links in the consumer, then `bun add droveragent@<version>` and repeat step 3.

## Releases

Releases are tag-triggered and published by `.github/workflows/release.yml` behind an approval; the procedure and owner setup are in [RELEASING.md](RELEASING.md). The versioning plan (lockstep versions, `0.3.0-next.N` prereleases on the `next` dist-tag) is tracked in [#34](https://github.com/nc9/drover/issues/34). `scripts/publish-all.sh` is the laptop fallback only.

## Security

Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).
