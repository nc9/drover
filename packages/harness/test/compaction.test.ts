import { describe, test, expect } from "bun:test";
import type { CompactionPolicy, HarnessEvent } from "@droveragent/core";
import { COMPACTION_SUMMARY_MARKER } from "@droveragent/core";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "@mariozechner/pi-ai";

import {
  buildSummaryMessage,
  CLEARED_PLACEHOLDER,
  dropToolResults,
  estimateTokens,
  initCompactionState,
  maybeCompact,
  renderTranscript,
  selectHeadTail,
  slidingWindow,
  summarizeStrategy,
  validateCompactionPolicy,
} from "../src/compaction/index.ts";

// ── fixtures ──────────────────────────────────────────────────────────────
const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user = (text: string, ts = 0): Message => ({ role: "user", content: text, timestamp: ts });

const asstText = (text: string, ts = 0): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "m",
  usage: ZERO_USAGE,
  stopReason: "stop",
  timestamp: ts,
});

const asstCall = (name: string, id: string, ts = 0): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: { q: 1 } }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "m",
  usage: ZERO_USAGE,
  stopReason: "toolUse",
  timestamp: ts,
});

const toolRes = (
  toolName: string,
  toolCallId: string,
  text: string,
  ts = 0,
): ToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text }],
  isError: false,
  timestamp: ts,
});

const BIG = "x".repeat(8000); // ~2000 tokens of tool output

/** 8-message convo: user task + 4 assistant turns (3 tool calls + final text). */
function convo(): Message[] {
  return [
    user("the original task"),
    asstCall("search", "c1"),
    toolRes("search", "c1", BIG),
    asstCall("read", "c2"),
    toolRes("read", "c2", BIG),
    asstCall("grep", "c3"),
    toolRes("grep", "c3", BIG),
    asstText("done"),
  ];
}

const PRESERVE = { firstUserTurn: true, recentTurns: 2 };

// ── selectHeadTail ──────────────────────────────────────────────────────────
describe("selectHeadTail", () => {
  test("keeps first user turn + last N assistant turns; head is the middle", () => {
    const { prefixEnd, headStart, headEnd } = selectHeadTail(convo(), PRESERVE);
    expect(prefixEnd).toBe(1); // msg[0] user preserved
    expect(headStart).toBe(1);
    // recentTurns=2 → tail begins at the 3rd-from-last assistant (idx 5); idx4 is a
    // toolResult (not user) so no user pulled in → tailStart 5.
    expect(headEnd).toBe(5);
  });

  test("firstUserTurn:false keeps nothing up front", () => {
    const { prefixEnd, headStart } = selectHeadTail(convo(), {
      firstUserTurn: false,
      recentTurns: 2,
    });
    expect(prefixEnd).toBe(0);
    expect(headStart).toBe(0);
  });

  test("recentTurns >= turn count ⇒ empty head (nothing to compact)", () => {
    const { headStart, headEnd } = selectHeadTail(convo(), {
      firstUserTurn: true,
      recentTurns: 10,
    });
    expect(headEnd).toBeLessThanOrEqual(headStart);
  });

  test("recentTurns 0 ⇒ no verbatim tail (head runs to the end)", () => {
    const msgs = convo();
    const { headEnd } = selectHeadTail(msgs, { firstUserTurn: true, recentTurns: 0 });
    expect(headEnd).toBe(msgs.length);
  });
});

// ── dropToolResults ──────────────────────────────────────────────────────────
describe("dropToolResults", () => {
  test("clears non-pinned toolResults in range, keeps toolCall records", () => {
    const msgs = convo();
    const { messages, changed } = dropToolResults(msgs, 1, 5, new Set());
    expect(changed).toBe(true);
    // idx2 + idx4 are toolResults in [1,5) → cleared
    expect((messages[2] as ToolResultMessage).content[0]).toEqual({
      type: "text",
      text: CLEARED_PLACEHOLDER,
    });
    expect((messages[2] as ToolResultMessage).toolCallId).toBe("c1"); // record preserved
    // assistant toolCall messages untouched
    expect(messages[1]).toBe(msgs[1]!);
    // tail (idx6 toolResult) untouched — out of range
    expect((messages[6] as ToolResultMessage).content[0]).toEqual(msgs[6]!.content[0] as never);
  });

  test("pinned tools survive", () => {
    const { messages } = dropToolResults(convo(), 1, 7, new Set(["read"]));
    expect((messages[4] as ToolResultMessage).content[0]).toMatchObject({ text: BIG }); // "read" pinned
    expect((messages[2] as ToolResultMessage).content[0]).toMatchObject({
      text: CLEARED_PLACEHOLDER,
    });
  });

  test("idempotent — re-running clears nothing new", () => {
    const once = dropToolResults(convo(), 1, 5, new Set());
    const twice = dropToolResults(once.messages, 1, 5, new Set());
    expect(twice.changed).toBe(false);
  });
});

// ── slidingWindow ────────────────────────────────────────────────────────────
describe("slidingWindow", () => {
  test("deletes the head, keeps opener + tail", () => {
    const msgs = convo();
    const out = slidingWindow(msgs, 1, 5);
    expect(out.length).toBe(msgs.length - 4);
    expect(out[0]).toBe(msgs[0]!); // opener
    expect(out[1]).toBe(msgs[5]!); // tail begins
  });

  test("empty range ⇒ unchanged copy", () => {
    const msgs = convo();
    expect(slidingWindow(msgs, 3, 3).length).toBe(msgs.length);
  });
});

// ── summarize helpers ────────────────────────────────────────────────────────
describe("summarize", () => {
  test("buildSummaryMessage marks the message and guards empty", () => {
    expect(buildSummaryMessage("a summary", 0).content).toBe(
      `${COMPACTION_SUMMARY_MARKER} a summary`,
    );
    expect(buildSummaryMessage("   ", 0).content).toBe(
      `${COMPACTION_SUMMARY_MARKER} (no summary available)`,
    );
  });

  test("renderTranscript flattens roles + tool calls", () => {
    const t = renderTranscript([
      user("hi"),
      asstCall("search", "c1"),
      toolRes("search", "c1", "res"),
    ]);
    expect(t).toContain("User: hi");
    expect(t).toContain("Assistant called search");
    expect(t).toContain("Tool result (search): res");
  });

  test("summarizeStrategy replaces head with one summary message", async () => {
    const msgs = convo();
    const out = await summarizeStrategy(msgs, 1, 5, async () => "SUM", "prompt", 0);
    expect(out.length).toBe(msgs.length - 4 + 1); // head (4) → 1 summary
    expect(out[1]!.role).toBe("user");
    expect((out[1] as { content: string }).content).toBe(`${COMPACTION_SUMMARY_MARKER} SUM`);
    expect(out[2]).toBe(msgs[5]!); // tail intact
  });
});

// ── validateCompactionPolicy ─────────────────────────────────────────────────
describe("validateCompactionPolicy", () => {
  const base: CompactionPolicy = { strategy: ["drop-tool-results"], preserve: PRESERVE };

  test("ok policies pass", () => {
    expect(validateCompactionPolicy(base)).toBeNull();
    expect(
      validateCompactionPolicy({ ...base, strategy: ["summarize"], summaryPrompt: "go" }),
    ).toBeNull();
  });

  test("summarize without summaryPrompt is rejected", () => {
    expect(validateCompactionPolicy({ ...base, strategy: ["summarize"] })).toContain(
      "summaryPrompt",
    );
  });

  test("empty strategy rejected", () => {
    expect(validateCompactionPolicy({ ...base, strategy: [] })).toContain("at least one");
  });

  test("out-of-range triggers rejected", () => {
    expect(
      validateCompactionPolicy({ ...base, trigger: { kind: "context_fraction", value: 1.5 } }),
    ).toContain("(0,1)");
    expect(
      validateCompactionPolicy({ ...base, trigger: { kind: "input_tokens", value: 0 } }),
    ).toContain("> 0");
  });
});

// ── maybeCompact (orchestrator) ──────────────────────────────────────────────
function collector() {
  const events: HarnessEvent[] = [];
  return { events, emit: (e: HarnessEvent) => events.push(e) };
}
const compactionEvents = (events: HarnessEvent[]) => events.filter((e) => e.kind === "compaction");

describe("maybeCompact", () => {
  const dropPolicy: CompactionPolicy = {
    strategy: ["drop-tool-results"],
    preserve: PRESERVE,
    trigger: { kind: "context_fraction", value: 0.5 },
  };

  test("auto: no-op when under budget", async () => {
    const { events, emit } = collector();
    const msgs = [user("hi"), asstText("yo")];
    const out = await maybeCompact({
      messages: msgs,
      policy: dropPolicy,
      contextWindow: 1_000_000,
      currentTurn: 1,
      state: initCompactionState(),
      runId: "r",
      emit,
    });
    expect(out).toBe(msgs); // same reference
    expect(compactionEvents(events).length).toBe(0);
  });

  test("auto: fires over budget, emits event, reclaims", async () => {
    const { events, emit } = collector();
    const msgs = convo();
    const before = estimateTokens(msgs);
    const out = await maybeCompact({
      messages: msgs,
      policy: dropPolicy,
      contextWindow: 1000, // usable = 500; convo is way over
      currentTurn: 3,
      state: initCompactionState(),
      runId: "r",
      emit,
    });
    expect(estimateTokens(out)).toBeLessThan(before);
    expect(estimateTokens(msgs)).toBeLessThan(before); // persisted IN PLACE (pi keeps this ref)
    const ce = compactionEvents(events);
    expect(ce.length).toBe(1);
    expect(ce[0]).toMatchObject({
      trigger: "auto",
      strategy: "drop-tool-results",
      summarized: false,
      turn: 3,
    });
    expect((ce[0] as { collapsedRange: [number, number] }).collapsedRange).toEqual([1, 5]);
  });

  test("manual-only policy (no trigger): no auto fire, fires on manual flag", async () => {
    const manualPolicy: CompactionPolicy = { strategy: ["drop-tool-results"], preserve: PRESERVE };
    // auto attempt → no trigger → no-op
    const auto = collector();
    const msgs = convo();
    const noop = await maybeCompact({
      messages: msgs,
      policy: manualPolicy,
      contextWindow: 1000,
      currentTurn: 1,
      state: initCompactionState(),
      runId: "r",
      emit: auto.emit,
    });
    expect(noop).toBe(msgs);
    expect(compactionEvents(auto.events).length).toBe(0);
    // manual → fires
    const man = collector();
    const out = await maybeCompact({
      messages: convo(),
      policy: manualPolicy,
      contextWindow: 1000,
      currentTurn: 2,
      state: initCompactionState(),
      runId: "r",
      emit: man.emit,
      manual: {},
    });
    const ce = compactionEvents(man.events);
    expect(ce.length).toBe(1);
    expect(ce[0]).toMatchObject({ trigger: "manual" });
    // drop-tool-results keeps message count but clears content
    expect(
      out.some(
        (m) =>
          m.role === "toolResult" &&
          (m as ToolResultMessage).content[0]?.type === "text" &&
          (m as ToolResultMessage).content[0]?.text === CLEARED_PLACEHOLDER,
      ),
    ).toBe(true);
  });

  test("commit mutates the passed array in place (persists across turns)", async () => {
    const { emit } = collector();
    const msgs = convo();
    const out = await maybeCompact({
      messages: msgs,
      policy: { strategy: ["sliding-window"], preserve: PRESERVE },
      contextWindow: 1000,
      currentTurn: 1,
      state: initCompactionState(),
      runId: "r",
      emit,
      manual: {},
    });
    expect(out).toBe(msgs); // same reference returned
    expect(msgs.length).toBe(4); // opener + 3-msg tail; the 4-msg head was dropped
  });

  test("cooldown: skips an auto pass within cooldownTurns of the last", async () => {
    const { events, emit } = collector();
    const policy: CompactionPolicy = { ...dropPolicy, cooldownTurns: 3 };
    const state = initCompactionState();
    state.lastCompactedTurn = 5;
    const msgs = convo();
    const out = await maybeCompact({
      messages: msgs,
      policy,
      contextWindow: 1000,
      currentTurn: 6, // 6 - 5 = 1 < 3 → cooldown
      state,
      runId: "r",
      emit,
    });
    expect(out).toBe(msgs);
    expect(compactionEvents(events).length).toBe(0);
  });

  test("minReclaimTokens: a pass below the floor is skipped (no-op)", async () => {
    const { events, emit } = collector();
    const policy: CompactionPolicy = { ...dropPolicy, minReclaimTokens: 100_000_000 };
    const msgs = convo();
    const out = await maybeCompact({
      messages: msgs,
      policy,
      contextWindow: 1000,
      currentTurn: 1,
      state: initCompactionState(),
      runId: "r",
      emit,
    });
    expect(out).toBe(msgs); // nothing committed
    expect(compactionEvents(events).length).toBe(0);
  });

  test("ladder: drop then summarize, summarize event marked summarized", async () => {
    const { events, emit } = collector();
    const policy: CompactionPolicy = {
      strategy: ["summarize"],
      preserve: PRESERVE,
      trigger: { kind: "context_fraction", value: 0.5 },
      summaryPrompt: "summarize it",
    };
    const out = await maybeCompact({
      messages: convo(),
      policy,
      contextWindow: 1000,
      currentTurn: 4,
      state: initCompactionState(),
      runId: "r",
      emit,
      summarize: async () => "CONDENSED",
    });
    const ce = compactionEvents(events);
    expect(ce.length).toBe(1);
    expect(ce[0]).toMatchObject({ strategy: "summarize", summarized: true });
    expect(
      out.some(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.startsWith(COMPACTION_SUMMARY_MARKER),
      ),
    ).toBe(true);
  });

  test("never throws: a summariser failure returns original + emits CompactionError", async () => {
    const { events, emit } = collector();
    const policy: CompactionPolicy = {
      strategy: ["summarize"],
      preserve: PRESERVE,
      summaryPrompt: "go",
    };
    const msgs = convo();
    const out = await maybeCompact({
      messages: msgs,
      policy,
      contextWindow: 1000,
      currentTurn: 1,
      state: initCompactionState(),
      runId: "r",
      emit,
      manual: {},
      summarize: async () => {
        throw new Error("boom");
      },
    });
    expect(out).toBe(msgs); // unchanged
    expect(compactionEvents(events).length).toBe(0);
    const errs = events.filter((e) => e.kind === "error");
    expect(errs.length).toBe(1);
    expect((errs[0] as { tag: string }).tag).toBe("CompactionError");
  });

  test("manual instructions override the summary prompt", async () => {
    const { emit } = collector();
    let seenPrompt = "";
    const policy: CompactionPolicy = {
      strategy: ["summarize"],
      preserve: PRESERVE,
      summaryPrompt: "default prompt",
    };
    await maybeCompact({
      messages: convo(),
      policy,
      contextWindow: 1000,
      currentTurn: 1,
      state: initCompactionState(),
      runId: "r",
      emit,
      manual: { instructions: "focus on the error" },
      summarize: async (_head, prompt) => {
        seenPrompt = prompt;
        return "ok";
      },
    });
    expect(seenPrompt).toBe("focus on the error");
  });
});
