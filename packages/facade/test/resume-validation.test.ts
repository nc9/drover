import { describe, test, expect } from "bun:test";
import { Type } from "@sinclair/typebox";
import { Effect } from "effect";
import { defineAgent } from "@droveragent/core";
import { createLibsqlStorage } from "@droveragent/storage";

import { resumeAgent } from "../src/index.ts";

const stableSpec = defineAgent({
  id: "validator",
  systemPrompt: "stable",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Object({ ok: Type.Boolean() }),
  model: "cheap",
  tools: [],
  quota: { maxTurns: 2 },
});

const seedPausedRun = async (
  storage: Awaited<ReturnType<typeof createLibsqlStorage>>,
  id: string,
  agentId: string,
  specHash: string,
): Promise<void> => {
  await Effect.runPromise(
    storage.createRun({
      id,
      agentId,
      specHash,
      status: "paused",
      input: { q: "x" },
      startedAt: Date.now(),
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    }),
  );
  await Effect.runPromise(
    storage.saveCheckpoint({
      runId: id,
      seq: 1,
      messages: [{ role: "user", content: "x" }],
      usage: { inputTokens: 0, outputTokens: 0 },
      toolCalls: [],
      retriesUsed: 0,
      ts: Date.now(),
    }),
  );
};

describe("resumeAgent validation", () => {
  test("rejects unknown runId with ResumeError", async () => {
    const storage = await createLibsqlStorage({ url: ":memory:" });
    const r = await resumeAgent(stableSpec, "nonexistent", { storage }).result;
    expect(r.status).toBe("error");
    expect(r.error?.tag).toBe("ResumeError");
    expect(r.error?.message).toContain("not found");
  });

  test("rejects non-paused status", async () => {
    const storage = await createLibsqlStorage({ url: ":memory:" });
    await Effect.runPromise(
      storage.createRun({
        id: "done",
        agentId: "validator",
        specHash: "h",
        status: "success",
        input: {},
        startedAt: Date.now(),
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      }),
    );
    const r = await resumeAgent(stableSpec, "done", { storage }).result;
    expect(r.status).toBe("error");
    expect(r.error?.message).toContain("not paused");
  });

  test("rejects agent id mismatch", async () => {
    const storage = await createLibsqlStorage({ url: ":memory:" });
    await seedPausedRun(storage, "wrong-agent", "other-agent", "h");
    const r = await resumeAgent(stableSpec, "wrong-agent", { storage }).result;
    expect(r.status).toBe("error");
    expect(r.error?.message).toContain("recorded under agent");
  });

  test("rejects spec hash drift", async () => {
    const storage = await createLibsqlStorage({ url: ":memory:" });
    await seedPausedRun(storage, "drifted", "validator", "different-hash");
    const r = await resumeAgent(stableSpec, "drifted", { storage }).result;
    expect(r.status).toBe("error");
    expect(r.error?.message).toContain("spec drift");
  });
});
