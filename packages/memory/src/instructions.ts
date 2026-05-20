import { MemoryError } from "@drover/core";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { MemoryAdapter } from "./adapter.ts";
import { stableId } from "./ulid.ts";

/** One discovered instruction file along the ancestor chain. */
export interface InstructionFile {
  /** Absolute path to the file. */
  path: string;
  /** Absolute directory the file lives in. */
  dir: string;
  /** Directory relative to the resolved root (`""` at the root). */
  relativeDir: string;
  /** Bare filename, e.g. `AGENTS.md`. */
  filename: string;
  /** File body. Truncated to `maxBytesPerFile` with a notice if oversized. */
  content: string;
  /** True when `content` was truncated. */
  truncated: boolean;
}

export interface LoadInstructionsOptions {
  /** Run working directory — bottom of the ancestor chain. Required. */
  cwd: string;
  /** Filenames to match, in precedence order. Default `["AGENTS.md", "CLAUDE.md"]`. */
  filenames?: ReadonlyArray<string>;
  /** Top of the ancestor chain. Default: nearest `.git` ancestor of cwd, else cwd. */
  root?: string;
  /** Per-file byte cap. Default 16384. */
  maxBytesPerFile?: number;
}

export const DEFAULT_INSTRUCTION_FILENAMES: ReadonlyArray<string> = [
  "AGENTS.md",
  "CLAUDE.md",
];

const DEFAULT_MAX_BYTES = 16 * 1024;
/** Cap the upward walk so a stray cwd can't climb the whole filesystem. */
const MAX_WALK_DEPTH = 40;

/**
 * Discover instruction files along the ancestor chain from `root` down
 * to `cwd`. Returns root-first (least-specific first) so the caller can
 * render with nearer files last.
 *
 * Nothing is loaded unless the caller asks — there is no implicit scan.
 */
export async function loadInstructionFiles(
  opts: LoadInstructionsOptions,
): Promise<ReadonlyArray<InstructionFile>> {
  const cwd = path.resolve(opts.cwd);
  const filenames = opts.filenames ?? DEFAULT_INSTRUCTION_FILENAMES;
  const maxBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES;
  const root = opts.root ? path.resolve(opts.root) : await detectRoot(cwd);

  // Collect dirs from cwd up to (and including) root.
  const dirs: string[] = [];
  let dir = cwd;
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    dirs.push(dir);
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit filesystem root
    if (!isInside(parent, root) && parent !== root) {
      // Walked above root without matching it — stop at cwd-only.
      break;
    }
    dir = parent;
  }
  dirs.reverse(); // root-first

  const out: InstructionFile[] = [];
  for (const d of dirs) {
    for (const filename of filenames) {
      const file = path.join(d, filename);
      let raw: string;
      try {
        raw = await fs.readFile(file, "utf8");
      } catch {
        continue; // not present in this dir
      }
      const { content, truncated } = clamp(raw, maxBytes);
      out.push({
        path: file,
        dir: d,
        relativeDir: path.relative(root, d),
        filename,
        content,
        truncated,
      });
    }
  }
  return out;
}

/** True when `child` is `ancestor` or nested under it. */
function isInside(child: string, ancestor: string): boolean {
  if (child === ancestor) return true;
  return child.startsWith(ancestor + path.sep);
}

/** Walk up from `cwd` to the nearest dir containing `.git`; else return `cwd`. */
async function detectRoot(cwd: string): Promise<string> {
  let dir = cwd;
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    try {
      await fs.stat(path.join(dir, ".git"));
      return dir;
    } catch {
      /* keep climbing */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

function clamp(raw: string, maxBytes: number): { content: string; truncated: boolean } {
  const buf = Buffer.from(raw, "utf8");
  if (buf.byteLength <= maxBytes) return { content: raw.trim(), truncated: false };
  const slice = buf.subarray(0, maxBytes).toString("utf8");
  return {
    content: `${slice.trim()}\n\n[...truncated — file exceeds ${maxBytes} bytes]`,
    truncated: true,
  };
}

/**
 * Render discovered instruction files as a system-prompt block. Files
 * are emitted in the order given (callers pass root-first). Returns `""`
 * when there's nothing to render so callers can append unconditionally.
 */
export function renderInstructionsBlock(files: ReadonlyArray<InstructionFile>): string {
  if (files.length === 0) return "";
  const lines: string[] = [
    "",
    "## Project instructions",
    "",
    "Authoritative AGENTS.md / CLAUDE.md files governing this working directory,",
    "least-specific first. Follow them.",
    "",
  ];
  for (const f of files) {
    const label = f.relativeDir === "" ? "(repo root)" : f.relativeDir;
    lines.push(`### ${label} — ${f.filename}`, "", f.content, "");
  }
  return lines.join("\n").trimEnd();
}

/**
 * Seed discovered instruction files into a memory adapter as read-only
 * `reference` entries (scope `global`, tag `instructions`). Ids are
 * derived deterministically from the file path, so re-seeding is an
 * idempotent upsert — not an accumulation.
 */
export function seedInstructionFiles(
  adapter: MemoryAdapter,
  files: ReadonlyArray<InstructionFile>,
): Effect.Effect<void, MemoryError, never> {
  return Effect.gen(function* () {
    for (const f of files) {
      const label = f.relativeDir === "" ? "(repo root)" : f.relativeDir;
      yield* adapter.put({
        id: stableId(f.path),
        scope: "global",
        kind: "reference",
        summary: `Project instructions — ${label} (${f.filename})`,
        body: f.content,
        tags: ["instructions"],
      });
    }
  });
}
