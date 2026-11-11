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

Run these before opening a PR, for the packages and files you touched only.

```bash
# typecheck one package (never the whole repo at once)
cd packages/<pkg> && ../../node_modules/.bin/tsgo --noEmit

# lint and format only your changed files
bunx oxlint <changed files>
bunx oxfmt <changed files>
bunx oxfmt --check <changed files>

# tests: always explicit file paths, from the package dir, a few at a time
cd packages/<pkg> && bun test test/foo.test.ts test/bar.test.ts

# build check
cd packages/<pkg> && bunx tsc -p tsconfig.build.json --noEmit
```

Do not run `oxfmt` on a directory: it reformats the whole repo. Do not run a bare `bun test`: a package's test files share one process.

## Commits

Use `type(scope): message #issue`, for example `fix(harness): retry output decode once #123`.

- Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `chore`.
- Scope is required and is usually the package name.
- One branch per issue, branched from `main`.

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

## Releases

Maintainers cut releases with `scripts/publish-all.sh`, which builds every package in dependency order and publishes only versions not already on the registry. Release tracking lives in the issue tracker: https://github.com/nc9/drover/issues?q=label%3Arelease.

## Security

Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).
