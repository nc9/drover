// Workspace package metadata shared by CI (scripts/ci.ts), the release
// tooling and scripts/publish-all.sh. One source for the dependency order.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..");

// Build + publish order: every package after all of its workspace deps.
export const PACKAGE_ORDER: readonly string[] = [
  "core",
  "sandbox",
  "sandbox-vercel",
  "sandbox-cloudflare",
  "tools",
  "memory",
  "plugins",
  "skills",
  "prompt",
  "commands",
  "mcp",
  "model",
  "storage",
  "storage-d1",
  "harness",
  "sandbox-just-bash",
  "facade",
  "runtime",
  "eval",
  "droveragent",
];

export type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

// `bun scripts/ci.ts pack --out <dir>` writes <dir>/index.json: PackEntry[]
// in PACKAGE_ORDER, consumed by scripts/release.ts.
export const PACK_INDEX = "index.json";
export type PackEntry = { pkg: string; name: string; version: string; tarball: string };

export const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;

export const packageDir = (pkg: string): string => join(REPO_ROOT, "packages", pkg);

export const readManifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;

export const workspacePackages = (): string[] =>
  readdirSync(join(REPO_ROOT, "packages"))
    .filter((d) => existsSync(join(packageDir(d), "package.json")))
    .toSorted();

// name -> version for every packages/* member.
export const workspaceVersions = (): Map<string, string> =>
  new Map(
    workspacePackages().map((d) => {
      const m = readManifest(packageDir(d));
      return [m.name, m.version] as const;
    }),
  );

const workspaceDepsOf = (m: Manifest, names: ReadonlySet<string>): string[] =>
  DEP_FIELDS.flatMap((f) => Object.keys(m[f] ?? {})).filter((d) => names.has(d));

// Problems with PACKAGE_ORDER: missing/unknown packages, or a package listed
// before one of its workspace deps. Empty when the order is sound.
export const orderProblems = (): string[] => {
  const dirs = workspacePackages();
  const missing = dirs.filter((d) => !PACKAGE_ORDER.includes(d));
  const unknown = PACKAGE_ORDER.filter((d) => !dirs.includes(d));
  const nameToDir = new Map(dirs.map((d) => [readManifest(packageDir(d)).name, d] as const));
  const names = new Set(nameToDir.keys());
  const position = new Map(PACKAGE_ORDER.map((d, i) => [d, i] as const));
  const misordered = PACKAGE_ORDER.filter((d) => dirs.includes(d)).flatMap((d) =>
    workspaceDepsOf(readManifest(packageDir(d)), names)
      .map((dep) => nameToDir.get(dep) ?? dep)
      .filter((depDir) => (position.get(depDir) ?? -1) > (position.get(d) ?? -1))
      .map((depDir) => `${d} is ordered before its dependency ${depDir}`),
  );
  return [
    ...missing.map((d) => `packages/${d} is missing from PACKAGE_ORDER (scripts/workspace.ts)`),
    ...unknown.map((d) => `PACKAGE_ORDER lists ${d} but packages/${d} does not exist`),
    ...misordered,
  ];
};

// Workspace deps in a packed manifest whose version differs from the live
// package.json version (the stale bun.lock failure mode).
export const staleWorkspaceDeps = (
  packed: Manifest,
  versions: ReadonlyMap<string, string>,
): string[] =>
  DEP_FIELDS.flatMap((field) =>
    Object.entries(packed[field] ?? {})
      .filter(([dep, ver]) => versions.has(dep) && ver !== versions.get(dep))
      .map(([dep, ver]) => `${dep}@${ver} (workspace has ${versions.get(dep)})`),
  );

if (import.meta.main) {
  // `bun scripts/workspace.ts` prints the order, one per line (for shell use).
  const problems = orderProblems();
  if (problems.length > 0) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  console.log(PACKAGE_ORDER.join("\n"));
}
