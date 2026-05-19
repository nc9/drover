import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Materialised skill record. `body` is the markdown after frontmatter,
 * loaded eagerly so `skill_load` is a fast in-memory lookup at run time.
 * For large skill libraries flip to lazy reads via `SkillRegistry`.
 */
export interface SkillSpec {
  name: string;
  description: string;
  body: string;
  /** Filesystem path the skill was read from. Useful for debugging. */
  path: string;
  /** Extra frontmatter fields preserved verbatim (version, tags, …). */
  metadata: Readonly<Record<string, unknown>>;
}

export class SkillLoadError extends Error {
  constructor(filepath: string, reason: string) {
    super(`SKILL.md at ${filepath}: ${reason}`);
    this.name = "SkillLoadError";
  }
}

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/**
 * Parse a single SKILL.md. Frontmatter MUST include `name` + `description`.
 * Everything after the closing `---` is the body, trimmed.
 */
export function parseSkillFile(contents: string, filepath: string): SkillSpec {
  const match = contents.match(FRONTMATTER);
  if (!match) throw new SkillLoadError(filepath, "missing YAML frontmatter (--- ... ---)");
  const fm = parseYaml(match[1]!) as Partial<{ name: string; description: string }> &
    Record<string, unknown>;
  if (!fm || typeof fm !== "object") {
    throw new SkillLoadError(filepath, "frontmatter must be an object");
  }
  if (typeof fm.name !== "string" || fm.name.length === 0) {
    throw new SkillLoadError(filepath, "frontmatter requires a 'name' string");
  }
  if (typeof fm.description !== "string" || fm.description.length === 0) {
    throw new SkillLoadError(filepath, "frontmatter requires a 'description' string");
  }
  return {
    name: fm.name,
    description: fm.description.trim(),
    body: match[2]!.trim(),
    path: filepath,
    metadata: fm,
  };
}

export interface ScanOptions {
  /**
   * Filename to look for inside each candidate dir. Defaults to "SKILL.md".
   * Some projects ship `skill.md` lowercase; override if needed.
   */
  filename?: string;
  /**
   * Recursion depth. The canonical layout is `<root>/<skill-name>/SKILL.md`
   * — depth 2 covers that. Increase if you nest categories.
   */
  maxDepth?: number;
  /** Skip directories whose name starts with one of these prefixes. */
  skipPrefixes?: ReadonlyArray<string>;
}

const DEFAULT_SKIP = [".", "_", "node_modules"];

/**
 * Scan one or more roots for SKILL.md files. Returns specs deduped by
 * `name` (first occurrence wins — order roots most-specific first so
 * agent-local skills shadow shared ones).
 */
export async function scanSkillDirs(
  roots: ReadonlyArray<string>,
  opts: ScanOptions = {},
): Promise<ReadonlyArray<SkillSpec>> {
  const filename = opts.filename ?? "SKILL.md";
  const maxDepth = opts.maxDepth ?? 3;
  const skipPrefixes = opts.skipPrefixes ?? DEFAULT_SKIP;
  const out = new Map<string, SkillSpec>();

  for (const root of roots) {
    const abs = path.resolve(root);
    let exists = false;
    try {
      const st = await fs.stat(abs);
      exists = st.isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) continue;
    await walk(abs, 0, maxDepth, filename, skipPrefixes, out);
  }
  return [...out.values()];
}

async function walk(
  dir: string,
  depth: number,
  maxDepth: number,
  filename: string,
  skipPrefixes: ReadonlyArray<string>,
  out: Map<string, SkillSpec>,
): Promise<void> {
  if (depth > maxDepth) return;
  const candidate = path.join(dir, filename);
  try {
    const contents = await fs.readFile(candidate, "utf8");
    const spec = parseSkillFile(contents, candidate);
    if (!out.has(spec.name)) out.set(spec.name, spec);
    return; // Each leaf dir holds at most one skill — stop descending.
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EISDIR") {
      // Parse failure: rethrow so projects see misconfigured skills early.
      if (err instanceof SkillLoadError) throw err;
    }
  }
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (skipPrefixes.some((p) => e.name.startsWith(p))) continue;
    await walk(path.join(dir, e.name), depth + 1, maxDepth, filename, skipPrefixes, out);
  }
}
