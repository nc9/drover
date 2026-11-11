import type { HarnessEvent } from "../src/index.ts";

type Kind = HarnessEvent["kind"];
const base = { runId: "run_1", ts: 1_700_000_000_000 };

/** One well-formed event of every kind. `Record<Kind, ...>` makes a new kind a compile error here. */
export const SAMPLES: Record<Kind, HarnessEvent> = {
  run_start: { ...base, kind: "run_start", agentId: "a", specHash: "abc" },
  input_validated: { ...base, kind: "input_validated" },
  turn_start: { ...base, kind: "turn_start", turn: 1 },
  llm_call: { ...base, kind: "llm_call", turn: 1, modelName: "m", reasoning: "low" },
  assistant_text: { ...base, kind: "assistant_text", turn: 1, text: "hi" },
  thinking: { ...base, kind: "thinking", turn: 1, text: "hm" },
  assistant_delta: { ...base, kind: "assistant_delta", turn: 1, text: "h" },
  thinking_delta: { ...base, kind: "thinking_delta", turn: 1, text: "h" },
  tool_call_start: {
    ...base,
    kind: "tool_call_start",
    turn: 1,
    toolUseId: "t1",
    toolName: "read",
    input: { path: "/x" },
  },
  tool_call_end: {
    ...base,
    kind: "tool_call_end",
    turn: 1,
    toolUseId: "t1",
    toolName: "read",
    result: { content: "ok" },
    durationMs: 12,
    trust: "untrusted",
  },
  usage: {
    ...base,
    kind: "usage",
    turn: 1,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
  },
  compaction: {
    ...base,
    kind: "compaction",
    turn: 2,
    trigger: "auto",
    strategy: "drop-tool-results",
    beforeTokens: 900,
    afterTokens: 300,
    collapsedRange: [1, 5],
    summarized: false,
  },
  subagent_start: { ...base, kind: "subagent_start", childRunId: "run_1:1", agentId: "child" },
  subagent_end: { ...base, kind: "subagent_end", childRunId: "run_1:1", status: "success" },
  output_validated: { ...base, kind: "output_validated" },
  output_retry: { ...base, kind: "output_retry", attempt: 1, reason: "bad json" },
  run_end: { ...base, kind: "run_end", status: "success" },
  memory_written: {
    ...base,
    kind: "memory_written",
    entry: { id: "m1", scope: "global", kind: "user", summary: "s" },
  },
  memory_recalled: {
    ...base,
    kind: "memory_recalled",
    query: null,
    scopes: ["global"],
    hits: [{ id: "m1", scope: "global", score: 1 }],
  },
  prompt_rendered: {
    ...base,
    kind: "prompt_rendered",
    cacheablePrefixChars: 10,
    totalChars: 20,
    reordered: false,
    warnings: [],
  },
  error: { ...base, kind: "error", tag: "ProviderError", message: "402" },
};
