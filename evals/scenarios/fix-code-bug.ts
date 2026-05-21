import { Type } from "@sinclair/typebox";
import { defineAgent } from "@drover/core";
import type { Scenario } from "./types.ts";

const spec = defineAgent({
  id: "fixer",
  systemPrompt: [
    "You are a code-fixer agent. The user gives you a failing test suite in the working directory.",
    "",
    "Steps:",
    "  1. Run the tests with `bash` (`bun test`) to see what's failing.",
    "  2. Read the failing file(s) with `read`.",
    "  3. Apply minimal fixes with `edit`. Do NOT refactor unrelated code.",
    "  4. Re-run the tests until they pass.",
    "  5. Reply with your final JSON output summarising what you fixed.",
    "",
    "Stop after at most 8 turns. If you can't make the tests pass, set `fixed=false` and explain.",
  ].join("\n"),
  inputSchema: Type.Object({
    test_cmd: Type.String(),
    hint: Type.Optional(Type.String()),
  }),
  outputSchema: Type.Object({
    fixed: Type.Boolean(),
    files_changed: Type.Array(Type.String()),
    summary: Type.String(),
  }),
  model: "mini",
  tools: ["bash", "read", "edit", "grep", "ls"],
  quota: { maxTurns: 10 },
});

export const scenario: Scenario<typeof spec> = {
  id: "fix-code-bug",
  name: "Fix a failing test by editing buggy code",
  category: "policy",
  description: "Agent reads code, identifies bug, edits file, re-runs tests until green.",
  fixtureDir: "fix-code-bug",
  spec,
  input: {
    test_cmd: "bun test",
    hint: "Only one function is buggy. Tests live in *.test.ts.",
  },
};
