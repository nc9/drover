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

ORDER=(core sandbox sandbox-vercel sandbox-cloudflare tools memory plugins skills prompt \
       commands mcp model storage storage-d1 harness sandbox-just-bash facade runtime eval \
       droveragent)

echo "▶ building all (dependency order)…"
for p in "${ORDER[@]}"; do
  (cd "packages/$p" && rm -rf dist && bunx tsc -p tsconfig.build.json \
     && bun run ../../scripts/postbuild-dts.ts >/dev/null) \
    || { echo "✗ build failed: $p"; exit 1; }
done
echo "✓ build ok"

# Pre-flight: bun rewrites workspace:* deps at pack/publish time from the
# versions recorded in bun.lock — NOT package.json. A stale lock (version bump
# without a lock refresh; plain `bun install` does not update the workspace
# "version" fields) would publish manifests depending on old, possibly
# never-published versions — uninstallable, while every check below still
# passes. Pack each package and verify its workspace dep versions BEFORE
# touching the registry (npm versions are immutable; a bad publish burns the
# version number).
echo "▶ verifying packed workspace dep versions…"
pack_tmp=$(mktemp -d)
trap 'rm -rf "$pack_tmp"' EXIT
for p in "${ORDER[@]}"; do
  rm -f "$pack_tmp"/*.tgz
  pack_out=$(cd "packages/$p" && bun pm pack --destination "$pack_tmp" 2>&1) \
    || { echo "✗ pack failed: $p"; echo "$pack_out"; exit 1; }
  tar -xzOf "$pack_tmp"/*.tgz package/package.json >"$pack_tmp/manifest.json"
  bun -e '
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const want = Object.fromEntries(
      fs.readdirSync("packages")
        .map((d) => `packages/${d}/package.json`)
        .filter((f) => fs.existsSync(f))
        .map((f) => JSON.parse(fs.readFileSync(f, "utf8")))
        .map((p) => [p.name, p.version]),
    );
    const bad = [];
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [dep, ver] of Object.entries(manifest[field] ?? {})) {
        if (dep in want && ver !== want[dep]) bad.push(`${dep}@${ver} (workspace has ${want[dep]})`);
      }
    }
    if (bad.length > 0) {
      console.error(`stale workspace deps in packed ${manifest.name}: ${bad.join(", ")}`);
      process.exit(1);
    }
  ' "$pack_tmp/manifest.json" || {
    echo "✗ bun.lock is out of sync with package.json versions — bun publish"
    echo "  would ship manifests depending on old versions. Update the workspace"
    echo "  \"version\" fields in bun.lock (plain 'bun install' does NOT refresh"
    echo "  them) and retry."
    exit 1
  }
done
echo "✓ packed workspace dep versions ok"

echo "▶ publishing…"
published=0
skipped=0
for p in "${ORDER[@]}"; do
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
  (cd "packages/$p" && bun publish "$@") \
    || { echo "✗ publish FAILED: ${name}@${version} — aborting; later packages NOT published"; exit 1; }
  published=$((published + 1))
done
echo "✓ done — ${published} published, ${skipped} skipped (already on registry)"
