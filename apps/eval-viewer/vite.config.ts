import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Effect } from "effect";
import { createLibsqlStorage, type StorageAdapter } from "@droveragent/storage";

const EVAL_RESULTS = path.resolve(__dirname, "../../evals/eval-results");

// DROVER_STORAGE_URL points at the libsql DB the viewer should read for
// runs persisted via the storage adapter (any drover run with `storage`
// wired ends up here). Common values:
//   file:./var/drover.db          — production daemon, file-backed
//   libsql://...                  — Turso/remote
//   ":memory:"                    — in-process (only useful when the
//                                    viewer shares a process with the runner)
// When unset, the storage-backed endpoints return 503 and the viewer
// falls back to the filesystem-only `/api/runsets/*` paths.
const STORAGE_URL = process.env.DROVER_STORAGE_URL ?? null;

/**
 * Reads the eval-results directory off disk and exposes:
 *   GET /api/runsets                       — list runsets, newest first
 *   GET /api/runsets/:id                   — runset summary + scenario list
 *   GET /api/runsets/:id/:scenario         — full result.json for a scenario
 */
function evalResultsApi(): Plugin {
  return {
    name: "eval-results-api",
    configureServer(server) {
      server.middlewares.use("/api/runsets", async (req, res, next): Promise<void> => {
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          const parts = url.pathname.split("/").filter(Boolean);
          res.setHeader("content-type", "application/json");

          if (parts.length === 0) {
            const entries = await fs.readdir(EVAL_RESULTS).catch(() => []);
            const runsets = entries
              .filter((n) => /^20\d\d-/.test(n))
              .sort()
              .reverse();
            const out = await Promise.all(
              runsets.map(async (id) => {
                const dir = path.join(EVAL_RESULTS, id);
                const stat = await fs.stat(dir);
                const scenarioDirs = (await fs.readdir(dir, { withFileTypes: true }))
                  .filter((d) => d.isDirectory())
                  .map((d) => d.name);
                let scenarios: Array<{ id: string; status: string; turns: number; costUsd: number }> = [];
                for (const s of scenarioDirs) {
                  try {
                    const json = JSON.parse(
                      await fs.readFile(path.join(dir, s, "result.json"), "utf8"),
                    );
                    scenarios.push({
                      id: s,
                      status: json.status,
                      turns: json.turns ?? 0,
                      costUsd: json.costUsd ?? 0,
                    });
                  } catch {
                    /* skip dirs without result.json */
                  }
                }
                return { id, ts: stat.mtime.toISOString(), scenarios };
              }),
            );
            res.end(JSON.stringify(out));
            return;
          }

          if (parts.length === 1) {
            const id = parts[0]!;
            const dir = path.join(EVAL_RESULTS, id);
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const scenarios: unknown[] = [];
            for (const e of entries) {
              if (!e.isDirectory()) continue;
              try {
                const json = JSON.parse(
                  await fs.readFile(path.join(dir, e.name, "result.json"), "utf8"),
                );
                scenarios.push({
                  id: e.name,
                  name: json.name,
                  category: json.category,
                  description: json.description,
                  status: json.status,
                  turns: json.turns,
                  durationMs: json.durationMs,
                  tokens: json.tokens,
                  costUsd: json.costUsd,
                  toolCalls: json.toolCalls,
                  error: json.error,
                });
              } catch {
                /* skip */
              }
            }
            let reportMd = "";
            try {
              reportMd = await fs.readFile(path.join(dir, "report.md"), "utf8");
            } catch {
              /* optional */
            }
            res.end(JSON.stringify({ id, scenarios, reportMd }));
            return;
          }

          if (parts.length === 2) {
            const [id, scenario] = parts;
            const file = path.join(EVAL_RESULTS, id!, scenario!, "result.json");
            const content = await fs.readFile(file, "utf8");
            res.end(content);
            return;
          }

          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not found" }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: (err as Error).message }));
          next();
        }
      });
    },
  };
}

/**
 * Storage-backed endpoints:
 *   GET /api/storage/runs                     — list run rows (newest first)
 *   GET /api/storage/runs/:id                 — single run + events + checkpoint
 *
 * Lazy-opens the libsql client on first request so the dev server starts
 * even when the configured URL points at a non-existent file.
 */
function storageApi(): Plugin {
  let storagePromise: Promise<StorageAdapter> | null = null;
  const getStorage = (): Promise<StorageAdapter> | null => {
    if (!STORAGE_URL) return null;
    if (!storagePromise) {
      storagePromise = createLibsqlStorage({ url: STORAGE_URL });
    }
    return storagePromise;
  };

  return {
    name: "storage-api",
    configureServer(server) {
      server.middlewares.use("/api/storage", async (req, res, next): Promise<void> => {
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          const parts = url.pathname.split("/").filter(Boolean);
          res.setHeader("content-type", "application/json");

          const storage = getStorage();
          if (!storage) {
            res.statusCode = 503;
            res.end(
              JSON.stringify({
                error: "storage not configured — set DROVER_STORAGE_URL",
              }),
            );
            return;
          }
          const s = await storage;

          // /api/storage/runs
          if (parts[0] === "runs" && parts.length === 1) {
            const limitParam = url.searchParams.get("limit");
            const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
            const runs = await Effect.runPromise(s.listRuns({ limit }));
            res.end(JSON.stringify({ runs }));
            return;
          }

          // /api/storage/runs/:id
          if (parts[0] === "runs" && parts.length === 2) {
            const id = parts[1]!;
            const run = await Effect.runPromise(s.loadRun(id));
            if (!run) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: "run not found" }));
              return;
            }
            const [events, checkpoint] = await Promise.all([
              Effect.runPromise(s.listEvents(id)),
              Effect.runPromise(s.loadLatestCheckpoint(id)),
            ]);
            res.end(JSON.stringify({ run, events, checkpoint }));
            return;
          }

          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not found" }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: (err as Error).message }));
          next();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwind(), evalResultsApi(), storageApi()],
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
});
