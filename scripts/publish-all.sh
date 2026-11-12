#!/usr/bin/env bash
# Build + publish all workspace packages in dependency order.
#
# Fail-fast: the first build or publish failure aborts the whole script with
# a non-zero exit — later packages are NOT attempted, so the registry never
# ends up with a partially-published, internally-inconsistent release.
#
# A package is skipped ONLY when that exact name@version is already on the
# registry (explicit `npm view` check, loudly logged). Auth failures, network
# errors, and every other publish failure abort.
#
# Prefer the release workflow (RELEASING.md): it adds npm provenance. This
# script is the laptop fallback; prereleases go to the `next` dist-tag.
#
# Usage:
#   scripts/publish-all.sh                 # uses npm automation token in ~/.npmrc (no OTP prompts)
#   scripts/publish-all.sh --otp=123456    # pass an OTP through to each `bun publish`
# Requires: npm login as an org member; dist is rebuilt via each package's build.
set -euo pipefail
cd "$(dirname "$0")/.."

# Dependency order lives in scripts/workspace.ts (shared with CI + release);
# it exits non-zero when the order misses a package or lists one before a dep.
# shellcheck disable=SC2207
ORDER=($(bun scripts/workspace.ts)) || { echo "✗ package order check failed"; exit 1; }
# Published packages only: `"private": true` packages are built but never published.
# shellcheck disable=SC2207
PUBLISH=($(bun scripts/workspace.ts --publish)) || { echo "✗ package order check failed"; exit 1; }

# A release build: dist/version.js gets the plain version (scripts/postbuild-version.ts).
export DROVER_RELEASE=1

echo "▶ building all (dependency order)…"
for p in "${ORDER[@]}"; do
  (cd "packages/$p" && rm -rf dist && bunx tsc -p tsconfig.build.json \
     && bun run ../../scripts/postbuild-dts.ts >/dev/null) \
    || { echo "✗ build failed: $p"; exit 1; }
done
echo "✓ build ok"

# Pre-flight: bun rewrites workspace:* deps at pack/publish time from the
# versions recorded in bun.lock, NOT package.json. A stale lock would publish
# manifests depending on old, possibly never-published versions. Pack each
# package and verify its workspace dep versions BEFORE touching the registry
# (npm versions are immutable; a bad publish burns the version number). Same
# check as the CI "pack" gate.
echo "▶ verifying packed workspace dep versions…"
bun scripts/ci.ts pack || exit 1

echo "▶ publishing…"
published=0
skipped=0
for p in "${PUBLISH[@]}"; do
  name=$(bun -e "console.log(require('./packages/$p/package.json').name)")
  version=$(bun -e "console.log(require('./packages/$p/package.json').version)")

  # Skip only a version that is verifiably already on the registry. `npm view`
  # exit codes differ across npm majors for a missing version (E404 vs empty
  # stdout + exit 0), so require BOTH success and non-empty STDOUT to skip.
  # Streams are captured separately: merging stderr in would let npm warnings
  # (config notices etc.) make a missing version look published → false skip.
  # Any non-404 failure (registry outage, auth, bad config) aborts — treating
  # it as "not published" would defeat the check's purpose.
  view_rc=0
  view_err_file=$(mktemp)
  view_out=$(npm view "${name}@${version}" version 2>"$view_err_file") || view_rc=$?
  view_err=$(<"$view_err_file")
  rm -f "$view_err_file"
  if [ "$view_rc" -eq 0 ] && [ -n "$view_out" ]; then
    echo "↷ SKIP ${name}@${version} — exact version already on registry"
    skipped=$((skipped + 1))
    continue
  fi
  if [ "$view_rc" -ne 0 ] && ! grep -q "E404" <<<"$view_out"$'\n'"$view_err"; then
    echo "✗ registry check failed for ${name}@${version} (not a 404) — aborting:"
    echo "$view_out"
    echo "$view_err"
    exit 1
  fi

  echo "── publishing ${name}@${version} ──"
  # A prerelease (0.3.0-next.1) must never take the `latest` dist-tag.
  tag_args=()
  if [[ "$version" == *-* ]]; then tag_args=(--tag next); fi
  (cd "packages/$p" && bun publish ${tag_args[@]+"${tag_args[@]}"} "$@") \
    || { echo "✗ publish FAILED: ${name}@${version} — aborting; later packages NOT published"; exit 1; }
  published=$((published + 1))
done
echo "✓ done — ${published} published, ${skipped} skipped (already on registry)"
