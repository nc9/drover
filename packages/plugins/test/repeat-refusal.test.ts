import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { HarnessEvent, RunContext, ToolResult } from "@droveragent/core";

import { repeatRefusalPlugin, type RepeatRefusalOptions } from "../src/index.ts";

const ctx = (runId = "r1"): RunContext => ({
  runId,
  depth: 0,
  cwd: "/tmp",
  env: {},
  signal: new AbortController().signal,
});

/** Drives the plugin like the harness: decide, then (if allowed) start and end the call. */
function driver(opts: RepeatRefusalOptions = {}) {
  const plugin = repeatRefusalPlugin(opts);
  let id = 0;
  const call = async (
    toolName: string,
    input: unknown,
    result: Pick<ToolResult, "isError" | "denied">,
    runId = "r1",
    extra: { destructive?: boolean; startInput?: unknown } = {},
  ) => {
    const toolUseId = `t${++id}`;
    const decision = await Effect.runPromise(
      plugin.beforeToolCall!(toolName, input, ctx(runId), {
        toolUseId,
        ...(extra.destructive !== undefined
          ? {
              tool: {
                id: toolName,
                description: "",
                inputSchema: {} as never,
                destructive: extra.destructive,
                execute: () => Effect.succeed({ content: "" }),
              },
            }
          : {}),
      }),
    );
    const ev = (e: Record<string, unknown>) =>
      Effect.runPromise(plugin.onEvent!(e as unknown as HarnessEvent, ctx(runId)));
    const startInput = "startInput" in extra ? extra.startInput : input;
    await ev({
      kind: "tool_call_start",
      runId,
      turn: 1,
      toolUseId,
      toolName,
      input: startInput,
      ts: 0,
    });
    const ended: ToolResult =
      decision.kind === "deny"
        ? {
            content: decision.reason,
            isError: true,
            denied: { plugin: "x", ...(decision.code ? { code: decision.code } : {}) },
          }
        : { content: "r", ...result };
    await ev({
      kind: "tool_call_end",
      runId,
      turn: 1,
      toolUseId,
      toolName,
      result: ended,
      durationMs: 1,
      ts: 0,
    });
    return decision;
  };
  return { plugin, call };
}

const failed = { isError: true };
const ok = {};

describe("repeatRefusalPlugin", () => {
  test("an identical repeat of a failed call is answered, not run, naming the earlier failure", async () => {
    const { call, plugin } = driver();
    expect((await call("fetch", { url: "a" }, failed)).kind).toBe("allow");
    const d = await call("fetch", { url: "a" }, ok);
    expect(d).toMatchObject({ kind: "deny", code: "repeat_refusal" });
    expect((d as { reason: string }).reason).toContain(
      "This exact fetch call already failed once in this run (first at tool call 1)",
    );
    expect(plugin.usage("r1")).toEqual({ failed: 1, repeated: 1 });
  });

  test("reordered argument keys and padded strings are the same call", async () => {
    const { call } = driver();
    await call("write", { path: "a.md", body: "x" }, failed);
    expect((await call("write", { body: " x ", path: "a.md" }, ok)).kind).toBe("deny");
  });

  test("a call with changed arguments runs normally", async () => {
    const { call } = driver();
    await call("fetch", { url: "a" }, failed);
    expect((await call("fetch", { url: "b" }, ok)).kind).toBe("allow");
  });

  test("a retryable tool is run again up to its repeats, then guarded; a success forgets", async () => {
    const { call } = driver({ retryable: { fetch: 1 } });
    await call("fetch", { url: "a" }, failed);
    expect((await call("fetch", { url: "a" }, failed)).kind).toBe("allow"); // the one repeat
    expect((await call("fetch", { url: "a" }, ok)).kind).toBe("deny");
    const second = driver({ retryable: { fetch: 1 } });
    await second.call("fetch", { url: "a" }, failed);
    await second.call("fetch", { url: "a" }, ok); // the repeat succeeds
    expect((await second.call("fetch", { url: "a" }, ok)).kind).toBe("allow");
  });

  test("a tool-call-cap refusal is not remembered as this call's failure; a policy refusal is", async () => {
    const { call } = driver();
    await call(
      "fetch",
      { url: "a" },
      { isError: true, denied: { plugin: "tool-call-cap", code: "tool_call_cap" } },
    );
    expect((await call("fetch", { url: "a" }, ok)).kind).toBe("allow");
    await call("write", { path: "/etc" }, { isError: true, denied: { plugin: "write-policy" } });
    expect((await call("write", { path: "/etc" }, ok)).kind).toBe("deny");
  });

  test("memory is per run, survives the run's continuation, and is bounded", async () => {
    const { call } = driver({ maxFailuresPerRun: 2, maxRuns: 2 });
    await call("fetch", { url: "a" }, failed, "r1");
    // Another run does not see r1's failure.
    expect((await call("fetch", { url: "a" }, ok, "r2")).kind).toBe("allow");
    // A continuation of r1 (same run id, later) still does.
    expect((await call("fetch", { url: "a" }, ok, "r1")).kind).toBe("deny");
    // Bounded per run: a third distinct failure forgets the oldest.
    await call("fetch", { url: "b" }, failed, "r1");
    await call("fetch", { url: "c" }, failed, "r1");
    expect((await call("fetch", { url: "a" }, ok, "r1")).kind).toBe("allow");
    // Bounded runs: r3 and r4 push r1 and r2 out.
    await call("fetch", { url: "z" }, failed, "r3");
    await call("fetch", { url: "z" }, failed, "r4");
    expect((await call("fetch", { url: "c" }, ok, "r1")).kind).toBe("allow");
  });

  test("a per-tool key decides what the same call is; tool names are data", async () => {
    const { call } = driver({
      keyFor: { fetch: (i) => new URL((i as { url: string }).url).host },
    });
    await call("fetch", { url: "https://a.test/x" }, failed);
    expect((await call("fetch", { url: "https://a.test/y" }, ok)).kind).toBe("deny");
    const names = driver({ retryable: {} });
    await names.call("__proto__", { a: 1 }, failed);
    expect((await names.call("__proto__", { a: 1 }, ok)).kind).toBe("deny");
    await names.call("constructor", {}, failed);
    expect((await names.call("constructor", {}, ok)).kind).toBe("deny");
  });

  test("a successful destructive call forgets the run's failures; a harmless one does not", async () => {
    const { call } = driver();
    await call("bash", { cmd: "bun test" }, failed, "r1", { destructive: true });
    // nothing changed in between: still refused
    await call("read", { path: "a.ts" }, ok, "r1", { destructive: false });
    expect((await call("bash", { cmd: "bun test" }, ok, "r1", { destructive: true })).kind).toBe(
      "deny",
    );
    // an edit succeeds: the rerun is allowed again
    await call("edit", { path: "a.ts" }, ok, "r1", { destructive: true });
    expect((await call("bash", { cmd: "bun test" }, ok, "r1", { destructive: true })).kind).toBe(
      "allow",
    );
  });

  test("include and exclude pick the guarded tools; nothing is excluded by default", async () => {
    const only = driver({ include: ["fetch"] });
    await only.call("fetch", { u: 1 }, failed);
    await only.call("read", { p: 1 }, failed);
    expect((await only.call("fetch", { u: 1 }, ok)).kind).toBe("deny");
    expect((await only.call("read", { p: 1 }, ok)).kind).toBe("allow");
    const not = driver({ exclude: ["read"] });
    await not.call("read", { p: 1 }, failed);
    expect((await not.call("read", { p: 1 }, ok)).kind).toBe("allow");
    const all = driver();
    await all.call("read", { p: 1 }, failed);
    expect((await all.call("read", { p: 1 }, ok)).kind).toBe("deny");
  });

  test("a __proto__ argument is part of the fingerprint, not a prototype", async () => {
    const { call } = driver();
    await call("fetch", JSON.parse('{"__proto__":{"evil":true},"url":"a"}'), failed);
    // the same url without the __proto__ key is a different call
    expect((await call("fetch", { url: "a" }, ok)).kind).toBe("allow");
    expect(
      (await call("fetch", JSON.parse('{"__proto__":{"evil":true},"url":"a"}'), ok)).kind,
    ).toBe("deny");
  });

  test("a failure is recorded under the input beforeToolCall saw and the started input", async () => {
    // the harness validated/coerced the arguments ({ n: 1 }) but the event carries the raw ones
    const { call } = driver();
    await call("page", { n: 1 }, failed, "r1", { startInput: { n: "1" } });
    expect((await call("page", { n: 1 }, ok)).kind).toBe("deny");
    expect((await call("page", { n: "1" }, ok)).kind).toBe("deny");
  });

  test("large arguments are fingerprinted by a fixed-size digest and still told apart", async () => {
    const { call } = driver();
    const big = "x".repeat(200_000);
    await call("write", { body: `${big}a` }, failed);
    expect((await call("write", { body: `${big}b` }, ok)).kind).toBe("allow");
    expect((await call("write", { body: `${big}a` }, ok)).kind).toBe("deny");
  });
});
