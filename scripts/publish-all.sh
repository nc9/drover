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
# Usage:
#   scripts/publish-all.sh                 # uses npm automation token in ~/.npmrc (no OTP prompts)
#   scripts/publish-all.sh --otp=123456    # pass an OTP through to each `bun publish`
# Requires: npm login as an org member; dist is rebuilt via each package's build.
set -euo pipefail
cd "$(dirname "$0")/.."

ORDER=(core sandbox tools memory plugins skills prompt commands mcp model \
       storage harness sandbox-just-bash facade runtime eval droveragent)

echo "▶ building all (dependency order)…"
for p in "${ORDER[@]}"; do
  (cd "packages/$p" && rm -rf dist && bunx tsc -p tsconfig.build.json \
     && bun run ../../scripts/postbuild-dts.ts >/dev/null) \
    || { echo "✗ build failed: $p"; exit 1; }
done
echo "✓ build ok"

echo "▶ publishing…"
published=0
skipped=0
for p in "${ORDER[@]}"; do
  name=$(bun -e "console.log(require('./packages/$p/package.json').name)")
  version=$(bun -e "console.log(require('./packages/$p/package.json').version)")

  # Skip only a version that is verifiably already on the registry. `npm view`
  # exit codes differ across npm majors for a missing version (E404 vs empty
  # stdout + exit 0), so require BOTH success and non-empty output to skip.
  # Any non-404 failure (registry outage, auth, bad config) aborts — treating
  # it as "not published" would defeat the check's purpose.
  view_rc=0
  view_out=$(npm view "${name}@${version}" version 2>&1) || view_rc=$?
  if [ "$view_rc" -eq 0 ] && [ -n "$view_out" ]; then
    echo "↷ SKIP ${name}@${version} — exact version already on registry"
    skipped=$((skipped + 1))
    continue
  fi
  if [ "$view_rc" -ne 0 ] && ! grep -q "E404" <<<"$view_out"; then
    echo "✗ registry check failed for ${name}@${version} (not a 404) — aborting:"
    echo "$view_out"
    exit 1
  fi

  echo "── publishing ${name}@${version} ──"
  (cd "packages/$p" && bun publish "$@") \
    || { echo "✗ publish FAILED: ${name}@${version} — aborting; later packages NOT published"; exit 1; }
  published=$((published + 1))
done
echo "✓ done — ${published} published, ${skipped} skipped (already on registry)"
