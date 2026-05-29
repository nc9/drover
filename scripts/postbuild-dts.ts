/**
 * Post-build: tsc with rewriteRelativeImportExtensions rewrites .ts->.js in
 * emitted .js but NOT in emitted .d.ts (re-exports / inline import() types).
 * Rewrite relative ".ts" specifiers -> ".js" in dist/**\/*.d.ts so consumer
 * type resolution works. Operates on ./dist relative to cwd (the package dir).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const distDir = process.argv[2] ?? "dist";

const walk = (dir: string): string[] => {
  let out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (p.endsWith(".d.ts")) out.push(p);
  }
  return out;
};

// relative specifier (./x or ../x) ending in .ts/.tsx/.mts/.cts, in quotes
const re = /(["'])(\.\.?\/[^"']*?)\.(ts|tsx|mts|cts)\1/g;
const ext = (e: string) => (e === "mts" ? "mjs" : e === "cts" ? "cjs" : "js");

let touched = 0;
try {
  for (const f of walk(distDir)) {
    const src = readFileSync(f, "utf8");
    const next = src.replace(re, (_m, q, spec, e) => `${q}${spec}.${ext(e)}${q}`);
    if (next !== src) {
      writeFileSync(f, next);
      touched++;
    }
  }
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === "ENOENT") process.exit(0);
  throw err;
}
if (touched) console.log(`postbuild-dts: rewrote ${touched} .d.ts file(s) in ${distDir}`);
