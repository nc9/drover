// This package's version, registered for `droverVersions()` (@droveragent/core).
// Stamped into dist/version.js at build time by scripts/postbuild-version.ts: the plain
// package.json version for a release build (DROVER_RELEASE=1), "<version>+local.<sha>" for any
// other build. "source" when this file runs unbuilt.
export const version: string = "source";

type VersionRegistry = Map<string, Set<string>>;
const KEY = Symbol.for("droveragent.versions");
const holder = globalThis as unknown as Record<symbol, VersionRegistry | undefined>;
const registry = (holder[KEY] ??= new Map());
const seen = registry.get("@droveragent/tools") ?? new Set<string>();
seen.add(version);
registry.set("@droveragent/tools", seen);
