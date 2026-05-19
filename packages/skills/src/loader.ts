import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Materialised skill record per the Agent Skills specification
 * (https://agentskills.io/specification).
 *
 * Body is loaded eagerly so `skill_load` is a fast in-memory lookup at
 * run time. Resources under `scripts/`, `references/`, `assets/` are
 * NOT pre-loaded — read them on demand via `readSkillResource`.
 */
export interface SkillSpec {
  /** 1-64 chars, `[a-z0-9-]+`, no leading/trailing/consecutive hyphens. */
  name: string;
  /** 1-1024 chars. What the skill does and when to use it. */
  description: string;
  /** Optional. License name or a reference to a bundled file. */
  license?: string;
  /** Optional. ≤500 chars. Environment requirements. */
  compatibility?: string;
  /**
   * Optional. The spec's typed `metadata:` block — string→string map.
   * Distinct from `extra`, which holds any other frontmatter keys.
   */
  metadata: Readonly<Record<string, string>>;
  /**
   * Optional. Raw `allowed-tools` string from frontmatter (experimental
   * per spec). Use `parseAllowedTools()` to tokenise.
   */
  allowedTools?: string;
  /** Body markdown after frontmatter, trimmed. */
  body: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** Absolute path to the skill root directory (parent of SKILL.md). */
  dir: string;
  /**
   * Any frontmatter keys outside the spec's defined fields. Preserved
   * verbatim so consumers can ship custom extensions.
   */
  extra: Readonly<Record<string, unknown>>;
}

/** Non-fatal issue surfaced when parsing in `lenient` mode. */
export interface SkillIssue {
  field: string;
  message: string;
}

export class SkillLoadError extends Error {
  readonly issues: ReadonlyArray<SkillIssue>;
  constructor(filepath: string, issues: ReadonlyArray<SkillIssue> | string) {
    const list = typeof issues === "string" ? [{ field: "_", message: issues }] : issues;
    super(`SKILL.md at ${filepath}: ${list.map((i) => `${i.field}: ${i.message}`).join("; ")}`);
    this.name = "SkillLoadError";
    this.issues = list;
  }
}

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SPEC_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

export interface ParseOptions {
  /**
   * Strict (default) throws on any spec violation. Lenient parses what
   * it can and collects issues into the returned `warnings` array.
   */
  mode?: "strict" | "lenient";
  /**
   * Skip the rule that name must equal the parent directory name.
   * Useful for tests that supply synthetic paths.
   */
  skipParentDirCheck?: boolean;
}

export interface ParseResult {
  spec: SkillSpec;
  warnings: ReadonlyArray<SkillIssue>;
}

/**
 * Parse a single SKILL.md. Returns the spec plus any non-fatal issues
 * (lenient mode) or throws `SkillLoadError` (strict mode, default).
 */
export function parseSkill(contents: string, filepath: string, opts: ParseOptions = {}): ParseResult {
  const mode = opts.mode ?? "strict";
  const issues: SkillIssue[] = [];
  const fail = (field: string, message: string): void => {
    issues.push({ field, message });
  };

  const match = contents.match(FRONTMATTER);
  if (!match) {
    throw new SkillLoadError(filepath, [
      { field: "_", message: "missing YAML frontmatter (--- ... ---)" },
    ]);
  }

  let fm: Record<string, unknown>;
  try {
    const parsed = parseYaml(match[1]!);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("frontmatter must be an object");
    }
    fm = parsed as Record<string, unknown>;
  } catch (err) {
    throw new SkillLoadError(filepath, [
      { field: "_", message: `frontmatter parse: ${(err as Error).message}` },
    ]);
  }

  const dir = path.dirname(filepath);
  const parentName = path.basename(dir);

  // name
  const rawName = fm.name;
  if (typeof rawName !== "string" || rawName.length === 0) {
    fail("name", "required, must be a non-empty string");
  } else {
    if (rawName.length > 64) fail("name", "max 64 characters");
    if (!NAME_RE.test(rawName)) {
      fail(
        "name",
        "must match /^[a-z0-9]+(-[a-z0-9]+)*$/ — lowercase letters/digits with single internal hyphens",
      );
    }
    if (!opts.skipParentDirCheck && rawName !== parentName) {
      fail("name", `must equal parent directory name '${parentName}' (got '${rawName}')`);
    }
  }

  // description
  const rawDesc = fm.description;
  if (typeof rawDesc !== "string" || rawDesc.length === 0) {
    fail("description", "required, must be a non-empty string");
  } else if (rawDesc.length > 1024) {
    fail("description", `max 1024 characters (got ${rawDesc.length})`);
  }

  // license
  let license: string | undefined;
  if (fm.license !== undefined) {
    if (typeof fm.license !== "string" || fm.license.length === 0) {
      fail("license", "must be a non-empty string when present");
    } else {
      license = fm.license;
    }
  }

  // compatibility
  let compatibility: string | undefined;
  if (fm.compatibility !== undefined) {
    if (typeof fm.compatibility !== "string" || fm.compatibility.length === 0) {
      fail("compatibility", "must be a non-empty string when present");
    } else if (fm.compatibility.length > 500) {
      fail("compatibility", `max 500 characters (got ${fm.compatibility.length})`);
    } else {
      compatibility = fm.compatibility;
    }
  }

  // metadata
  const metadata: Record<string, string> = {};
  if (fm.metadata !== undefined) {
    if (typeof fm.metadata !== "object" || fm.metadata === null || Array.isArray(fm.metadata)) {
      fail("metadata", "must be a mapping of string keys to string values");
    } else {
      for (const [k, v] of Object.entries(fm.metadata as Record<string, unknown>)) {
        // Coerce scalars (numbers, bools) to strings — YAML often emits
        // unquoted versions like "1.0" as floats; carry them as text.
        if (v === null || v === undefined) continue;
        if (typeof v === "string") {
          metadata[k] = v;
        } else if (typeof v === "number" || typeof v === "boolean") {
          metadata[k] = String(v);
        } else {
          fail(`metadata.${k}`, `value must be a string (got ${typeof v})`);
        }
      }
    }
  }

  // allowed-tools
  // Spec says "space-separated string" but lists are common in the wild;
  // accept both shapes and normalise to the spec's string form.
  let allowedTools: string | undefined;
  const rawAt = fm["allowed-tools"];
  if (rawAt !== undefined) {
    if (typeof rawAt === "string") {
      if (rawAt.length === 0) {
        fail("allowed-tools", "must be a non-empty string when present");
      } else {
        allowedTools = rawAt;
      }
    } else if (Array.isArray(rawAt)) {
      const tokens = rawAt.filter((x): x is string => typeof x === "string" && x.length > 0);
      if (tokens.length !== rawAt.length) {
        fail("allowed-tools", "list entries must be non-empty strings");
      }
      if (tokens.length > 0) allowedTools = tokens.join(" ");
    } else {
      fail("allowed-tools", "must be a string or a list of strings");
    }
  }

  // extra (anything not in SPEC_KEYS)
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!SPEC_KEYS.has(k)) extra[k] = v;
  }

  if (issues.length > 0 && mode === "strict") {
    throw new SkillLoadError(filepath, issues);
  }

  const spec: SkillSpec = {
    name: typeof rawName === "string" ? rawName : "",
    description: typeof rawDesc === "string" ? rawDesc.trim() : "",
    ...(license !== undefined ? { license } : {}),
    ...(compatibility !== undefined ? { compatibility } : {}),
    metadata,
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    body: match[2]!.trim(),
    path: filepath,
    dir,
    extra,
  };
  return { spec, warnings: issues };
}

/**
 * Strict-mode convenience. Throws on any spec violation.
 * @deprecated Prefer `parseSkill` — exposes warnings and parse modes.
 */
export function parseSkillFile(contents: string, filepath: string): SkillSpec {
  return parseSkill(contents, filepath, { mode: "strict" }).spec;
}

/**
 * Tokenise an `allowed-tools` string. The spec says space-separated;
 * many real-world skills use comma-separated. Accept both.
 *
 * Bash sub-patterns like `Bash(git:*)` are preserved as a single token —
 * the splitter respects parenthesis depth.
 */
export function parseAllowedTools(raw: string | undefined): ReadonlyArray<string> {
  if (!raw) return [];
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  const push = (): void => {
    const t = buf.trim();
    if (t.length > 0) out.push(t);
    buf = "";
  };
  for (const ch of raw) {
    if (ch === "(") {
      depth++;
      buf += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      buf += ch;
    } else if (depth === 0 && (ch === " " || ch === "," || ch === "\t" || ch === "\n")) {
      push();
    } else {
      buf += ch;
    }
  }
  push();
  return out;
}

export interface ScanOptions {
  /**
   * Filename to look for inside each candidate dir. Defaults to "SKILL.md".
   * Override for legacy layouts (`skill.md` lowercase).
   */
  filename?: string;
  /**
   * Recursion depth. The canonical layout is `<root>/<skill-name>/SKILL.md`
   * — depth 2 covers that. Increase if you nest categories.
   */
  maxDepth?: number;
  /** Skip directories whose name starts with one of these prefixes. */
  skipPrefixes?: ReadonlyArray<string>;
  /** Parse mode forwarded to `parseSkill`. Defaults to strict. */
  mode?: "strict" | "lenient";
  /**
   * Optional sink for non-fatal issues encountered in lenient mode and
   * for skipped files (e.g. parse failures swallowed during scan).
   */
  onIssue?: (filepath: string, issues: ReadonlyArray<SkillIssue>) => void;
}

const DEFAULT_SKIP = [".", "_", "node_modules"];

/**
 * Scan one or more roots for SKILL.md files. Returns specs deduped by
 * `name` (first occurrence wins — order roots most-specific first so
 * agent-local skills shadow shared ones).
 *
 * In strict mode (default), a malformed SKILL.md throws and stops the
 * scan. In lenient mode, malformed files are reported via `onIssue` and
 * skipped.
 */
export async function scanSkillDirs(
  roots: ReadonlyArray<string>,
  opts: ScanOptions = {},
): Promise<ReadonlyArray<SkillSpec>> {
  const filename = opts.filename ?? "SKILL.md";
  const maxDepth = opts.maxDepth ?? 3;
  const skipPrefixes = opts.skipPrefixes ?? DEFAULT_SKIP;
  const mode = opts.mode ?? "strict";
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
    await walk(abs, 0, maxDepth, filename, skipPrefixes, mode, opts.onIssue, out);
  }
  return [...out.values()];
}

async function walk(
  dir: string,
  depth: number,
  maxDepth: number,
  filename: string,
  skipPrefixes: ReadonlyArray<string>,
  mode: "strict" | "lenient",
  onIssue: ScanOptions["onIssue"],
  out: Map<string, SkillSpec>,
): Promise<void> {
  if (depth > maxDepth) return;
  const candidate = path.join(dir, filename);
  try {
    const contents = await fs.readFile(candidate, "utf8");
    try {
      const { spec, warnings } = parseSkill(contents, candidate, { mode });
      if (warnings.length > 0 && onIssue) onIssue(candidate, warnings);
      if (!out.has(spec.name)) out.set(spec.name, spec);
      return; // Each leaf dir holds at most one skill — stop descending.
    } catch (err) {
      if (err instanceof SkillLoadError) {
        if (mode === "lenient") {
          if (onIssue) onIssue(candidate, err.issues);
          // fall through to descend — there may be valid nested skills
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EISDIR") {
      if (err instanceof SkillLoadError) throw err;
    }
  }
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (skipPrefixes.some((p) => e.name.startsWith(p))) continue;
    await walk(
      path.join(dir, e.name),
      depth + 1,
      maxDepth,
      filename,
      skipPrefixes,
      mode,
      onIssue,
      out,
    );
  }
}

/**
 * Enumerated supporting files under a skill's well-known directories.
 * Paths are relative to `spec.dir`, one level deep — matching the
 * spec's "keep file references one level deep" guidance.
 */
export interface SkillResources {
  scripts: ReadonlyArray<string>;
  references: ReadonlyArray<string>;
  assets: ReadonlyArray<string>;
  /** Any other top-level files (e.g. README.md, LICENSE). */
  other: ReadonlyArray<string>;
}

/**
 * List supporting files in a skill's directory. Reads only the
 * skill-rooted level; does not recurse into nested directories.
 */
export async function listSkillResources(spec: SkillSpec): Promise<SkillResources> {
  const scripts = await safeList(path.join(spec.dir, "scripts"));
  const references = await safeList(path.join(spec.dir, "references"));
  const assets = await safeList(path.join(spec.dir, "assets"));
  const top = await safeList(spec.dir);
  const known = new Set([
    "SKILL.md",
    "skill.md",
    "scripts",
    "references",
    "assets",
  ]);
  const other = top.filter((name) => !known.has(name));
  return { scripts, references, assets, other };
}

async function safeList(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => !e.name.startsWith(".")).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/**
 * Read a single file under a skill's directory. Refuses absolute paths
 * and any `..` segments — resource access stays inside the skill root.
 */
export async function readSkillResource(
  spec: SkillSpec,
  relativePath: string,
): Promise<string> {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`resource path must be relative (got '${relativePath}')`);
  }
  const normalised = path.normalize(relativePath);
  if (normalised.startsWith("..") || normalised.split(path.sep).includes("..")) {
    throw new Error(`resource path must not escape skill root (got '${relativePath}')`);
  }
  const abs = path.resolve(spec.dir, normalised);
  if (!abs.startsWith(spec.dir + path.sep) && abs !== spec.dir) {
    throw new Error(`resource resolved outside skill root: ${abs}`);
  }
  return await fs.readFile(abs, "utf8");
}
