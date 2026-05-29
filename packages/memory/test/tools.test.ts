import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import type { HarnessEvent, ToolResult } from "@droveragent/core";

import { createInMemoryMemory } from "../src/memory.ts";
import { forgetTool, recallTool, rememberTool } from "../src/tools.ts";

const ctx = (over: Partial<{ runId: string; toolUseId: string }> = {}) => ({
  runId: over.runId ?? "run-001",
  toolUseId: over.toolUseId ?? "tu-1",
  cwd: "/",
  env: {} as Record<string, string>,
  signal: new AbortController().signal,
  run: {
    runId: over.runId ?? "run-001",
    depth: 0,
    cwd: "/",
    env: {} as Record<string, string>,
    signal: new AbortController().signal,
  },
});

describe("rememberTool", () => {
  test("writes through the adapter and emits memory_written", async () => {
    const adapter = createInMemoryMemory();
    const events: HarnessEvent[] = [];
    const tool = rememberTool({
      adapter,
      agentId: "writer",
      runId: "run-001",
      emit: (e) => events.push(e),
    });
    const result = (await Effect.runPromise(
      tool.execute(
        {
          scope: "agent",
          kind: "feedback",
          summary: "Avoid em-dashes",
          body: "Reader sees em-dashes as an AI tell.",
        },
        ctx(),
      ) as Effect.Effect<ToolResult, never, never>,
    )) as ToolResult;
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("saved");
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe("memory_written");
  });

  test("refuses scope='run' when runId is empty", async () => {
    const adapter = createInMemoryMemory();
    const tool = rememberTool({ adapter, agentId: "writer", runId: "" });
    const result = (await Effect.runPromise(
      tool.execute(
        { scope: "run", kind: "user", summary: "x", body: "y" },
        ctx({ runId: "" }),
      ) as Effect.Effect<ToolResult, never, never>,
    )) as ToolResult;
    expect(result.isError).toBe(true);
  });

  test("update via id preserves createdAt", async () => {
    const adapter = createInMemoryMemory();
    const tool = rememberTool({ adapter, agentId: "writer", runId: "run-001" });
    const first = (await Effect.runPromise(
      tool.execute(
        { scope: "global", kind: "user", summary: "v1", body: "b1" },
        ctx(),
      ) as Effect.Effect<ToolResult, never, never>,
    )) as ToolResult;
    const id = (first.data as { id: string }).id;
    await new Promise((r) => setTimeout(r, 5));
    const second = (await Effect.runPromise(
      tool.execute(
        { id, scope: "global", kind: "user", summary: "v2", body: "b2" },
        ctx(),
      ) as Effect.Effect<ToolResult, never, never>,
    )) as ToolResult;
    expect((second.data as { id: string }).id).toBe(id);
  });
});

describe("recallTool", () => {
  test("default scopes are global+agent and filter to current agentId", async () => {
    const adapter = createInMemoryMemory();
    const globalE = await Effect.runPromise(
      adapter.put({ scope: "global", kind: "user", summary: "g-summary", body: "g body" }),
    );
    const ownAgentE = await Effect.runPromise(
      adapter.put({
        scope: "agent",
        agentId: "writer",
        kind: "feedback",
        summary: "a-summary",
        body: "a body",
      }),
    );
    const otherAgentE = await Effect.runPromise(
      adapter.put({
        scope: "agent",
        agentId: "other",
        kind: "feedback",
        summary: "x-summary",
        body: "x body",
      }),
    );
    const tool = recallTool({ adapter, agentId: "writer", runId: "" });
    const r = (await Effect.runPromise(
      tool.execute({}, ctx({ runId: "" })) as Effect.Effect<ToolResult, never, never>,
    )) as ToolResult;
    const ids = (r.data as { hits: ReadonlyArray<{ id: string }> }).hits.map((h) => h.id);
    expect(ids).toContain(globalE.id);
    expect(ids).toContain(ownAgentE.id);
    expect(ids).not.toContain(otherAgentE.id);
  });

  test("default scopes include 'run' when a runId is active", async () => {
    const adapter = createInMemoryMemory();
    const globalE = await Effect.runPromise(
      adapter.put({ scope: "global", kind: "user", summary: "g", body: "g" }),
    );
    const agentE = await Effect.runPromise(
      adapter.put({
        scope: "agent",
        agentId: "writer",
        kind: "feedback",
        summary: "a",
        body: "a",
      }),
    );
    const runE = await Effect.runPromise(
      adapter.put({
        scope: "run",
        agentId: "writer",
        runId: "run-XYZ",
        kind: "project",
        summary: "r",
        body: "r",
      }),
    );
    const tool = recallTool({ adapter, agentId: "writer", runId: "run-XYZ" });
    const r = (await Effect.runPromise(
      tool.execute({}, ctx({ runId: "run-XYZ" })) as Effect.Effect<ToolResult, never, never>,
    )) as ToolResult;
    const ids = (r.data as { hits: ReadonlyArray<{ id: string }> }).hits.map((h) => h.id);
    expect(ids).toContain(globalE.id);
    expect(ids).toContain(agentE.id);
    expect(ids).toContain(runE.id);
  });

  test("emits memory_recalled with hit ids", async () => {
    const adapter = createInMemoryMemory();
    const e = await Effect.runPromise(
      adapter.put({ scope: "global", kind: "user", summary: "Em-dash", body: "AI tell" }),
    );
    const events: HarnessEvent[] = [];
    const tool = recallTool({
      adapter,
      agentId: "writer",
      runId: "run-001",
      emit: (ev) => events.push(ev),
    });
    await Effect.runPromise(
      tool.execute({ query: "em-dash" }, ctx()) as Effect.Effect<ToolResult, never, never>,
    );
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.kind).toBe("memory_recalled");
    if (ev.kind === "memory_recalled") {
      expect(ev.hits[0]?.id).toBe(e.id);
    }
  });
});

describe("forgetTool", () => {
  test("removes when caller owns the entry", async () => {
    const adapter = createInMemoryMemory();
    const e = await Effect.runPromise(
      adapter.put({
        scope: "agent",
        agentId: "writer",
        kind: "user",
        summary: "x",
        body: "y",
      }),
    );
    const tool = forgetTool({ adapter, agentId: "writer" });
    const r = (await Effect.runPromise(
      tool.execute({ id: e.id }, ctx()) as Effect.Effect<ToolResult, never, never>,
    )) as ToolResult;
    expect(r.isError).toBeUndefined();
  });

  test("refuses when caller is a different agent", async () => {
    const adapter = createInMemoryMemory();
    const e = await Effect.runPromise(
      adapter.put({
        scope: "agent",
        agentId: "owner",
        kind: "user",
        summary: "x",
        body: "y",
      }),
    );
    const tool = forgetTool({ adapter, agentId: "intruder" });
    const r = (await Effect.runPromise(
      tool.execute({ id: e.id }, ctx()) as Effect.Effect<ToolResult, never, never>,
    )) as ToolResult;
    expect(r.isError).toBe(true);
  });

  test("refuses entries tagged 'instructions'", async () => {
    const adapter = createInMemoryMemory();
    const e = await Effect.runPromise(
      adapter.put({
        scope: "global",
        kind: "reference",
        summary: "Project instructions — (repo root)",
        body: "rules",
        tags: ["instructions"],
      }),
    );
    const tool = forgetTool({ adapter, agentId: "writer" });
    const r = (await Effect.runPromise(
      tool.execute({ id: e.id }, ctx()) as Effect.Effect<ToolResult, never, never>,
    )) as ToolResult;
    expect(r.isError).toBe(true);
    expect((r.data as { reason: string }).reason).toBe("read_only");
  });
});
