import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { defineAgent } from "@drover/core";

import { runAgent } from "../src/index.ts";

const spec = defineAgent({
  id: "sandbox-probe",
  systemPrompt: "probe",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Object({ ok: Type.Boolean() }),
  model: "cheap",
  tools: [],
  quota: { maxTurns: 1 },
});

describe("default sandbox", () => {
  // Regression: the default just-bash sandbox mounts cwd, and just-bash mount
  // targets must be absolute. A relative `options.cwd` must be resolved before
  // it reaches the mount — otherwise `runAgent` throws synchronously at setup.
  test("runAgent tolerates a relative cwd", async () => {
    let handle: ReturnType<typeof runAgent> | undefined;
    expect(() => {
      handle = runAgent(spec, { q: "x" }, { cwd: "." });
    }).not.toThrow();
    handle?.abort();
    await handle?.result;
  });
});
