import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * A command: a markdown prompt macro, host-pushed into a run as a
 * conversation turn (the dual of a skill, which the agent pulls).
 *
 * Unlike a skill — a directory with `SKILL.md` + resources — a command is
 * a single flat markdown file `<name>.md`. Its `body` is a Liquid prompt
 * template, rendered with caller-supplied `args` at invoke time.
 */
export interface CommandSpec {
  /** 1-64 chars, `[a-z0-9-]+`. Defaults to the filename (sans `.md`). */
  name: string;
  /** 1-1024 chars. What the command does. */
  description: string;
  /** Optional. Human hint describing expected `args` (frontmatter `argument-hint`). */
  argumentHint?: string;
  /** Optional typed `metadata:` block — string→string map. */
  metadata: Readonly<Record<string, string>>;
  /** Body markdown after frontmatter, trimmed — a Liquid template. */
  body: string;
  /** Absolute path to the command's `.md` file. */
  path: string;
  /** Frontmatter keys outside the defined fields, preserved verbatim. */
  extra: Readonly<Record<string, unknown>>;
}

/** Non-fatal issue surfaced when parsing in `lenient` mode. */
export interface CommandIssue {
  field: string;
  message: string;
}

export class CommandLoadError extends Error {
  readonly issues: ReadonlyArray<CommandIssue>;
  constructor(filepath: string, issues: ReadonlyArray<CommandIssue> | string) {
    const list = typeof issues === "string" ? [{ field: "_", message: issues }] : issues;
    super(`command at ${filepath}: ${list.map((i) => `${i.field}: ${i.message}`).join("; ")}`);
    this.name = "CommandLoadError";
    this.issues = list;
  }
}

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SPEC_KEYS = new Set(["name", "description", "argument-hint", "metadata"]);

export interface ParseOptions {
  /**
   * Strict (default) throws on any violation. Lenient parses what it can
   * and collects issues into the returned `warnings` array.
   */
  mode?: "strict" | "lenient";
}

export interface ParseResult {
  spec: CommandSpec;
  warnings: ReadonlyArray<CommandIssue>;
}

/**
 * Parse a single command `.md` file. Returns the spec plus any non-fatal
 * issues (lenient mode) or throws `CommandLoadError` (strict, default).
 *
 * `name` defaults to the filename without `.md`; a frontmatter `name`
 * overrides it. `description` is required.
 */
export function parseCommand(
  contents: string,
  filepath: string,
  opts: ParseOptions = {},
): ParseResult {
  const mode = opts.mode ?? "strict";
  const issues: CommandIssue[] = [];
  const fail = (field: string, message: string): void => {
    issues.push({ field, message });
  };

  const match = contents.match(FRONTMATTER);
  if (!match) {
    throw new CommandLoadError(filepath, [
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
    throw new CommandLoadError(filepath, [
      { field: "_", message: `frontmatter parse: ${(err as Error).message}` },
    ]);
  }

  // name — frontmatter `name` overrides the filename-derived default.
  const fileBase = path.basename(filepath).replace(/\.md$/i, "");
  let name = fileBase;
  if (fm.name !== undefined) {
    if (typeof fm.name !== "string" || fm.name.length === 0) {
      fail("name", "must be a non-empty string when present");
    } else {
      name = fm.name;
    }
  }
  if (name.length > 64) fail("name", "max 64 characters");
  if (!NAME_RE.test(name)) {
    fail(
      "name",
      "must match /^[a-z0-9]+(-[a-z0-9]+)*$/ — lowercase letters/digits with single internal hyphens",
    );
  }

  // description — required.
  const rawDesc = fm.description;
  if (typeof rawDesc !== "string" || rawDesc.length === 0) {
    fail("description", "required, must be a non-empty string");
  } else if (rawDesc.length > 1024) {
    fail("description", `max 1024 characters (got ${rawDesc.length})`);
  }

  // argument-hint — optional.
  let argumentHint: string | undefined;
  if (fm["argument-hint"] !== undefined) {
    const raw = fm["argument-hint"];
    if (typeof raw !== "string" || raw.length === 0) {
      fail("argument-hint", "must be a non-empty string when present");
    } else {
      argumentHint = raw;
    }
  }

  // metadata — optional string→string map.
  const metadata: Record<string, string> = {};
  if (fm.metadata !== undefined) {
    if (typeof fm.metadata !== "object" || fm.metadata === null || Array.isArray(fm.metadata)) {
      fail("metadata", "must be a mapping of string keys to string values");
    } else {
      for (const [k, v] of Object.entries(fm.metadata as Record<string, unknown>)) {
        if (v === null || v === undefined) continue;
        if (typeof v === "string") metadata[k] = v;
        else if (typeof v === "number" || typeof v === "boolean") metadata[k] = String(v);
        else fail(`metadata.${k}`, `value must be a string (got ${typeof v})`);
      }
    }
  }

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!SPEC_KEYS.has(k)) extra[k] = v;
  }

  if (issues.length > 0 && mode === "strict") {
    throw new CommandLoadError(filepath, issues);
  }

  const spec: CommandSpec = {
    name,
    description: typeof rawDesc === "string" ? rawDesc.trim() : "",
    ...(argumentHint !== undefined ? { argumentHint } : {}),
    metadata,
    body: match[2]!.trim(),
    path: filepath,
    extra,
  };
  return { spec, warnings: issues };
}

export interface ScanOptions {
  /** Parse mode forwarded to `parseCommand`. Defaults to strict. */
  mode?: "strict" | "lenient";
  /** Skip files whose name starts with one of these prefixes. */
  skipPrefixes?: ReadonlyArray<string>;
  /** Sink for non-fatal issues (lenient mode) and skipped files. */
  onIssue?: (filepath: string, issues: ReadonlyArray<CommandIssue>) => void;
}

const DEFAULT_SKIP = [".", "_"];

/**
 * Scan one or more roots for command `.md` files. Commands are flat
 * files directly under each root (no recursion). Returns specs deduped
 * by `name` — first occurrence wins, so order roots most-specific first
 * to let agent-local commands shadow shared ones.
 *
 * Strict mode (default): a malformed file throws and stops the scan.
 * Lenient mode: malformed files are reported via `onIssue` and skipped.
 */
export async function scanCommandDirs(
  roots: ReadonlyArray<string>,
  opts: ScanOptions = {},
): Promise<ReadonlyArray<CommandSpec>> {
  const mode = opts.mode ?? "strict";
  const skipPrefixes = opts.skipPrefixes ?? DEFAULT_SKIP;
  const out = new Map<string, CommandSpec>();

  for (const root of roots) {
    const abs = path.resolve(root);
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
      if (skipPrefixes.some((p) => e.name.startsWith(p))) continue;
      const filepath = path.join(abs, e.name);
      const contents = await fs.readFile(filepath, "utf8");
      try {
        const { spec, warnings } = parseCommand(contents, filepath, { mode });
        if (warnings.length > 0 && opts.onIssue) opts.onIssue(filepath, warnings);
        if (!out.has(spec.name)) out.set(spec.name, spec);
      } catch (err) {
        if (err instanceof CommandLoadError && mode === "lenient") {
          if (opts.onIssue) opts.onIssue(filepath, err.issues);
        } else {
          throw err;
        }
      }
    }
  }
  return [...out.values()];
}
