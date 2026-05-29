import { MemoryError } from "@droveragent/core";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type {
  MemoryAdapter,
  MemoryDraft,
  MemoryEntry,
  MemoryHit,
  MemoryKind,
  MemoryScope,
  SearchOpts,
} from "./adapter.ts";
import { ID_SEGMENT_RE, ULID_RE } from "./adapter.ts";
import { bm25, buildDoc, type Doc } from "./bm25.ts";
import { byRecency, matches } from "./filter.ts";
import { validateDraft } from "./memory.ts";
import { ulid } from "./ulid.ts";

export interface MarkdownMemoryOptions {
  /** Absolute or relative path to the memory root. Required. */
  root: string;
}

const KINDS: ReadonlySet<MemoryKind> = new Set([
  "user",
  "feedback",
  "project",
  "reference",
]);

const SCOPES: ReadonlySet<MemoryScope> = new Set(["global", "agent", "run"]);

/**
 * Markdown-on-disk memory adapter. File layout:
 *
 *   <root>/global/<id>.md
 *   <root>/agents/<agentId>/<id>.md
 *   <root>/runs/<runId>/<id>.md
 *
 * Each file is YAML frontmatter + markdown body. The adapter builds an
 * in-process index on construction and keeps it in sync with writes;
 * cross-process modifications won't be seen until the next process start.
 *
 * Concurrency: single-process. Writes are serialised through a Promise
 * queue so two concurrent `put` calls can't interleave YAML output.
 */
export async function createMarkdownMemory(
  opts: MarkdownMemoryOptions,
): Promise<MemoryAdapter> {
  const root = path.resolve(opts.root);
  await fs.mkdir(root, { recursive: true });

  const entries = new Map<string, MemoryEntry>();
  const docs = new Map<string, Doc>();
  let writeChain: Promise<void> = Promise.resolve();

  const persist = (entry: MemoryEntry): void => {
    entries.set(entry.id, entry);
    docs.set(entry.id, buildDoc(entry.id, entry.summary, entry.body, entry.tags));
  };

  // Initial scan
  await scanInto(root, entries, docs);

  /** Resolve the on-disk path for an entry. Throws on path-escape attempts. */
  const pathFor = (entry: MemoryEntry): string => {
    if (entry.scope === "global") {
      return path.join(root, "global", `${entry.id}.md`);
    }
    if (entry.scope === "agent") {
      return path.join(root, "agents", entry.agentId!, `${entry.id}.md`);
    }
    return path.join(root, "runs", entry.runId!, `${entry.id}.md`);
  };

  const writeFile = async (entry: MemoryEntry): Promise<void> => {
    const file = pathFor(entry);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const frontmatter: Record<string, unknown> = {
      id: entry.id,
      scope: entry.scope,
      kind: entry.kind,
      summary: entry.summary,
      createdAt: entry.createdAt,
    };
    if (entry.agentId) frontmatter.agentId = entry.agentId;
    if (entry.runId) frontmatter.runId = entry.runId;
    if (entry.tags && entry.tags.length > 0) frontmatter.tags = [...entry.tags];
    if (entry.updatedAt) frontmatter.updatedAt = entry.updatedAt;
    const yaml = stringifyYaml(frontmatter).trimEnd();
    const content = `---\n${yaml}\n---\n\n${entry.body.trim()}\n`;
    await fs.writeFile(file, content, "utf8");
  };

  const enqueueWrite = (task: () => Promise<void>): Promise<void> => {
    const next = writeChain.then(task, task);
    // Don't surface task errors to the chain (already surfaced to caller).
    writeChain = next.catch(() => undefined);
    return next;
  };

  return {
    id: "markdown",
    put: (draft: MemoryDraft) =>
      Effect.tryPromise({
        try: async (): Promise<MemoryEntry> => {
          const validation = validateDraft(draft);
          if (validation) throw validation;
          const now = Date.now();
          const id = draft.id ?? ulid(now);
          const existing = entries.get(id);
          const entry: MemoryEntry = {
            id,
            scope: draft.scope,
            ...(draft.agentId !== undefined ? { agentId: draft.agentId } : {}),
            ...(draft.runId !== undefined ? { runId: draft.runId } : {}),
            kind: draft.kind,
            summary: draft.summary,
            body: draft.body,
            ...(draft.tags && draft.tags.length > 0 ? { tags: [...draft.tags] } : {}),
            createdAt: existing?.createdAt ?? now,
            ...(existing ? { updatedAt: now } : {}),
          };
          // Write the new entry first, then unlink the old path if the
          // location changed. If the write fails, we keep the old durable
          // copy on disk; if the unlink fails afterwards, the new entry is
          // authoritative and the stale file is tolerable (a later put or
          // a fresh scan will reconcile).
          await enqueueWrite(() => writeFile(entry));
          if (existing && pathFor(existing) !== pathFor(entry)) {
            await enqueueWrite(async () => {
              try {
                await fs.unlink(pathFor(existing));
              } catch {
                /* tolerable — stale file, new entry already durable */
              }
            });
          }
          persist(entry);
          return entry;
        },
        catch: (err) =>
          err instanceof MemoryError
            ? err
            : new MemoryError({
                op: "put",
                reason: "io",
                message: (err as Error).message,
              }),
      }),

    get: (id) =>
      Effect.sync(() => entries.get(id) ?? null),

    search: (searchOpts: SearchOpts) =>
      Effect.sync((): ReadonlyArray<MemoryHit> => {
        const limit = searchOpts.limit ?? 20;
        const filtered = [...entries.values()].filter((e) =>
          matches(e, searchOpts, searchOpts.agentId),
        );
        if (!searchOpts.query || searchOpts.query.length === 0) {
          return filtered
            .sort(byRecency)
            .slice(0, limit)
            .map((e) => ({ ...e, score: 0 }));
        }
        const allowed = new Set(filtered.map((e) => e.id));
        const corpus = [...docs.values()].filter((d) => allowed.has(d.id));
        const scored = bm25(searchOpts.query, corpus);
        return scored
          .slice(0, limit)
          .map((s) => ({ ...(entries.get(s.id) as MemoryEntry), score: s.score }));
      }),

    list: (filter) =>
      Effect.sync(() =>
        [...entries.values()]
          .filter((e) => matches(e, filter, filter.agentId))
          .sort(byRecency)
          .slice(0, filter.limit ?? 20),
      ),

    forget: (id) =>
      Effect.tryPromise({
        try: async (): Promise<boolean> => {
          const entry = entries.get(id);
          if (!entry) return false;
          await enqueueWrite(async () => {
            try {
              await fs.unlink(pathFor(entry));
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code !== "ENOENT") throw err;
            }
          });
          entries.delete(id);
          docs.delete(id);
          return true;
        },
        catch: (err) =>
          err instanceof MemoryError
            ? err
            : new MemoryError({
                op: "forget",
                reason: "io",
                message: (err as Error).message,
                id,
              }),
      }),

    close: () =>
      Effect.tryPromise({
        try: () => writeChain.then(() => undefined),
        catch: (err) =>
          new MemoryError({
            op: "close",
            reason: "io",
            message: (err as Error).message,
          }),
      }),
  };
}

async function scanInto(
  root: string,
  entries: Map<string, MemoryEntry>,
  docs: Map<string, Doc>,
): Promise<void> {
  const globalDir = path.join(root, "global");
  for (const id of await listMdIds(globalDir)) {
    const entry = await loadFile(path.join(globalDir, `${id}.md`), { scope: "global" });
    if (entry) {
      entries.set(entry.id, entry);
      docs.set(entry.id, buildDoc(entry.id, entry.summary, entry.body, entry.tags));
    }
  }
  const agentsRoot = path.join(root, "agents");
  for (const agentId of await listSegments(agentsRoot)) {
    const agentDir = path.join(agentsRoot, agentId);
    for (const id of await listMdIds(agentDir)) {
      const entry = await loadFile(path.join(agentDir, `${id}.md`), {
        scope: "agent",
        agentId,
      });
      if (entry) {
        entries.set(entry.id, entry);
        docs.set(entry.id, buildDoc(entry.id, entry.summary, entry.body, entry.tags));
      }
    }
  }
  const runsRoot = path.join(root, "runs");
  for (const runId of await listSegments(runsRoot)) {
    const runDir = path.join(runsRoot, runId);
    for (const id of await listMdIds(runDir)) {
      const entry = await loadFile(path.join(runDir, `${id}.md`), {
        scope: "run",
        runId,
      });
      if (entry) {
        entries.set(entry.id, entry);
        docs.set(entry.id, buildDoc(entry.id, entry.summary, entry.body, entry.tags));
      }
    }
  }
}

async function listSegments(dir: string): Promise<string[]> {
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    return ents
      .filter((e) => e.isDirectory() && ID_SEGMENT_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function listMdIds(dir: string): Promise<string[]> {
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    return ents
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name.slice(0, -3))
      .filter((id) => ULID_RE.test(id));
  } catch {
    return [];
  }
}

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

async function loadFile(
  file: string,
  ctx: { scope: MemoryScope; agentId?: string; runId?: string },
): Promise<MemoryEntry | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  const m = raw.match(FRONTMATTER);
  if (!m) return null;
  let fm: Record<string, unknown>;
  try {
    const parsed = parseYaml(m[1]!);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    fm = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const id = typeof fm.id === "string" && ULID_RE.test(fm.id) ? fm.id : null;
  if (!id) return null;
  const kind = fm.kind as MemoryKind;
  if (!KINDS.has(kind)) return null;
  const scope = typeof fm.scope === "string" ? (fm.scope as MemoryScope) : ctx.scope;
  if (!SCOPES.has(scope)) return null;
  const summary = typeof fm.summary === "string" ? fm.summary : "";
  if (summary.length === 0) return null;
  const createdAt =
    typeof fm.createdAt === "number"
      ? fm.createdAt
      : Number.parseInt(String(fm.createdAt ?? ""), 10);
  if (!Number.isFinite(createdAt)) return null;
  const body = m[2]!.trim();
  const tags =
    Array.isArray(fm.tags) && fm.tags.every((t) => typeof t === "string")
      ? (fm.tags as string[])
      : undefined;
  const updatedAt =
    typeof fm.updatedAt === "number" ? fm.updatedAt : undefined;
  const agentIdValue =
    typeof fm.agentId === "string" && ID_SEGMENT_RE.test(fm.agentId)
      ? fm.agentId
      : ctx.agentId;
  const runIdValue =
    typeof fm.runId === "string" && ID_SEGMENT_RE.test(fm.runId)
      ? fm.runId
      : ctx.runId;
  return {
    id,
    scope,
    ...(agentIdValue !== undefined ? { agentId: agentIdValue } : {}),
    ...(runIdValue !== undefined ? { runId: runIdValue } : {}),
    kind,
    summary,
    body,
    ...(tags ? { tags } : {}),
    createdAt,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}
