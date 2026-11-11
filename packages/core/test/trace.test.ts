import { describe, expect, test } from "bun:test";

import {
  KNOWN_EVENT_KINDS,
  REQUIRED_FIELDS,
  TRACE_VERSION,
  parseTraceJsonl,
  readEvent,
  summarizeTrace,
  traceToJsonl,
  type HarnessEvent,
  type TraceEvent,
} from "../src/index.ts";
import { SAMPLES } from "./trace-samples.ts";

describe("trace format v1", () => {
  test("the version is 1 and the table covers every sampled kind", () => {
    expect(TRACE_VERSION).toBe(1);
    expect([...KNOWN_EVENT_KINDS].sort()).toEqual(Object.keys(SAMPLES).sort());
    expect(Object.keys(REQUIRED_FIELDS)).toHaveLength(KNOWN_EVENT_KINDS.length);
  });

  for (const [kind, sample] of Object.entries(SAMPLES)) {
    test(`${kind}: a well-formed event reads back identical (JSON round trip)`, () => {
      expect(readEvent(JSON.parse(JSON.stringify(sample)))).toEqual(sample);
    });
  }

  test("every required field is checked: removing or retyping one makes the event unreadable, not dropped", () => {
    for (const [kind, sample] of Object.entries(SAMPLES)) {
      for (const field of [
        "runId",
        "ts",
        ...Object.keys(REQUIRED_FIELDS[kind as keyof typeof REQUIRED_FIELDS]),
      ]) {
        const missing = { ...(sample as unknown as Record<string, unknown>) };
        delete missing[field];
        const r = readEvent(missing);
        expect(r).toMatchObject({ unknown: true, kind, reason: `malformed: ${field}` });
        expect((r as { raw: unknown }).raw).toEqual(missing);
        const retyped = readEvent({
          ...(sample as unknown as Record<string, unknown>),
          [field]: { x: 1 },
        });
        if (typeof (sample as unknown as Record<string, unknown>)[field] !== "object")
          expect(retyped).toMatchObject({ unknown: true });
      }
    }
  });

  test("unknown kinds, unknown fields and non-objects are tolerated", () => {
    const future = { kind: "provider_failover", runId: "r", ts: 1, from: "a", to: "b" };
    expect(readEvent(future)).toEqual({
      unknown: true,
      kind: "provider_failover",
      reason: "unknown_kind",
      raw: future,
    });
    const extra = { ...SAMPLES.turn_start, brandNewField: [1, 2] };
    expect(readEvent(extra)).toEqual(extra); // unknown field kept, event still typed
    for (const junk of [null, 5, "x", [1]])
      expect(readEvent(junk)).toMatchObject({ unknown: true, kind: "" });
  });

  test("JSONL: header line first, one event per line, unknown events written back as stored", () => {
    const future = { kind: "budget_warning", runId: "run_1", ts: 2, dimension: "turns" };
    const events: TraceEvent[] = [SAMPLES.run_start, readEvent(future), SAMPLES.run_end];
    const text = traceToJsonl({
      header: { traceVersion: 1, runId: "run_1", agentId: "a", harnessVersion: "0.2.0" },
      events,
    });
    const lines = text.trimEnd().split("\n");
    expect(JSON.parse(lines[0]!)).toEqual({
      kind: "trace_header",
      traceVersion: 1,
      runId: "run_1",
      agentId: "a",
      harnessVersion: "0.2.0",
    });
    expect(lines).toHaveLength(4);
    const back = parseTraceJsonl(text);
    expect(back.warnings).toEqual([]);
    expect(back.header.runId).toBe("run_1");
    expect(back.events).toEqual(events);
  });

  test("tolerant reader: bad lines skipped with a warning, missing header and newer versions flagged but read", () => {
    const bad = parseTraceJsonl(`not json\n${JSON.stringify(SAMPLES.run_start)}\n`);
    expect(bad.events).toHaveLength(1);
    expect(bad.warnings).toEqual(["line 1: not JSON", "no trace_header line"]);
    expect(bad.header).toEqual({ traceVersion: 0, runId: "run_1" });
    const newer = parseTraceJsonl(
      `${JSON.stringify({ kind: "trace_header", traceVersion: 2, runId: "r", futureField: 1 })}\n${JSON.stringify(SAMPLES.run_end)}\n`,
    );
    expect(newer.warnings[0]).toContain("newer than this reader");
    expect(newer.events).toHaveLength(1);
  });

  test("summary: comparable numbers, usage per provider, unknown kinds counted", () => {
    const events: TraceEvent[] = [
      SAMPLES.run_start,
      SAMPLES.turn_start,
      { ...SAMPLES.turn_start, turn: 2 } as HarnessEvent,
      SAMPLES.tool_call_end,
      {
        ...SAMPLES.tool_call_end,
        result: { content: "x", isError: true },
        durationMs: 8,
      } as HarnessEvent,
      { ...SAMPLES.usage, provider: "openrouter" } as HarnessEvent,
      { ...SAMPLES.usage, provider: "cloudflare-ai-gateway" } as HarnessEvent,
      SAMPLES.compaction,
      SAMPLES.subagent_start,
      SAMPLES.error,
      readEvent({ kind: "provider_failover", runId: "run_1", ts: 3 }),
      readEvent({ kind: "provider_failover", runId: "run_1", ts: 4 }),
      readEvent({ ...SAMPLES.llm_call, modelName: undefined }),
      SAMPLES.run_end,
    ];
    const s = summarizeTrace(events);
    expect(s).toMatchObject({
      status: "success",
      turns: 2,
      toolCalls: {
        count: 2,
        errors: 1,
        totalMs: 20,
        byTool: { read: { count: 2, errors: 1, totalMs: 20 } },
      },
      usage: { inputTokens: 20, outputTokens: 10 },
      usageByProvider: {
        openrouter: { inputTokens: 10 },
        "cloudflare-ai-gateway": { inputTokens: 10 },
      },
      compactions: 1,
      subagents: 1,
      errors: 1,
      unknownEvents: 3,
      unknownKinds: { provider_failover: 2 },
    });
    expect(s.usage.costUsd).toBeCloseTo(0.02);
  });
});
