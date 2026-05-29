import { describe, expect, test } from "bun:test";
import { createPromptEngine } from "@droveragent/prompt";

import { type CommandSpec, renderCommand } from "../src/index.ts";

const engine = createPromptEngine();

const cmd = (body: string): CommandSpec => ({
  name: "c",
  description: "d",
  metadata: {},
  body,
  path: "/x/c.md",
  extra: {},
});

describe("renderCommand", () => {
  test("interpolates args into {{ }} slots", async () => {
    const text = await renderCommand(cmd("Review PR {{ pr }} in {{ repo }}."), {
      engine,
      args: { pr: 42, repo: "drover" },
    });
    expect(text).toBe("Review PR 42 in drover.");
  });

  test("renders with no args", async () => {
    const text = await renderCommand(cmd("Run the lint check."), { engine });
    expect(text).toBe("Run the lint check.");
  });

  test("JSON-encodes non-scalar args so {{ }} still renders", async () => {
    const text = await renderCommand(cmd("opts={{ opts }}"), {
      engine,
      args: { opts: { fix: true } },
    });
    expect(text).toBe('opts={"fix":true}');
  });

  test("args override scope.vars", async () => {
    const text = await renderCommand(cmd("{{ x }}"), {
      engine,
      scope: { vars: { x: "from-scope" } },
      args: { x: "from-args" },
    });
    expect(text).toBe("from-args");
  });
});
