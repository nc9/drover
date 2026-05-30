#!/usr/bin/env bash
# Build + publish all workspace packages in dependency order.
# Usage:
#   scripts/publish-all.sh                 # uses npm automation token in ~/.npmrc (no OTP prompts)
#   scripts/publish-all.sh --otp=123456    # pass an OTP through to each `bun publish`
# Requires: npm login as an org member; dist is rebuilt via each package's build.
set -uo pipefail
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
fail=0
for p in "${ORDER[@]}"; do
  echo "── @droveragent/$p ──"
  (cd "packages/$p" && bun publish "$@") || { echo "⚠ $p not published (already exists / auth?)"; fail=$((fail+1)); }
done
echo "done — ${fail} package(s) not published"
exit 0
