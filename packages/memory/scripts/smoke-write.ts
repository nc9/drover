#!/usr/bin/env bun
/**
 * Smoke test for the markdown memory adapter. Writes one entry per
 * scope, lists everything, queries with BM25, and removes one entry.
 *
 * Run: bun packages/memory/scripts/smoke-write.ts [root]
 */

import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createMarkdownMemory } from "../src/index.ts";

async function main(): Promise<void> {
  const root =
    process.argv[2] ?? (await fs.mkdtemp(path.join(os.tmpdir(), "drover-mem-smoke-")));
  console.log(`root: ${root}`);

  const mem = await createMarkdownMemory({ root });

  const global = await Effect.runPromise(
    mem.put({
      scope: "global",
      kind: "user",
      summary: "Prefer concise commits",
      body: "Lowercase first word; subject line ≤72 chars.",
      tags: ["git", "style"],
    }),
  );
  console.log(`  wrote global: ${global.id}`);

  const agent = await Effect.runPromise(
    mem.put({
      scope: "agent",
      agentId: "writer",
      kind: "feedback",
      summary: "Avoid em-dashes",
      body: "Reader treats em-dashes as an AI tell.",
      tags: ["style", "writing"],
    }),
  );
  console.log(`  wrote agent: ${agent.id}`);

  const run = await Effect.runPromise(
    mem.put({
      scope: "run",
      agentId: "writer",
      runId: "smoke-001",
      kind: "project",
      summary: "Section 3 outline locked",
      body: "Move from history → comparison → recommendation.",
    }),
  );
  console.log(`  wrote run: ${run.id}`);

  const listed = await Effect.runPromise(
    mem.list({ scopes: ["global", "agent", "run"], agentId: "writer", runId: "smoke-001" }),
  );
  console.log(`\nlisted ${listed.length} entries:`);
  for (const e of listed) console.log(`  - [${e.scope}] ${e.summary}`);

  const hits = await Effect.runPromise(
    mem.search({ query: "em-dash style", scopes: ["global", "agent"], agentId: "writer" }),
  );
  console.log(`\nsearch 'em-dash style' → ${hits.length} hit(s):`);
  for (const h of hits) console.log(`  - [${h.scope}] ${h.summary}  (score ${h.score.toFixed(2)})`);

  const taggedHits = await Effect.runPromise(
    mem.list({ scopes: ["global", "agent"], agentId: "writer", tags: ["style"] }),
  );
  console.log(`\ntag filter 'style' → ${taggedHits.length} entries`);

  const removed = await Effect.runPromise(mem.forget(run.id));
  console.log(`\nforgot run entry: ${removed}`);

  await Effect.runPromise(mem.close());
  console.log("\ndone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
