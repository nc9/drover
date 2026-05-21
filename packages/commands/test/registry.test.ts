import { describe, expect, test } from "bun:test";

import { type CommandSpec, createCommandRegistry } from "../src/index.ts";

const cmd = (name: string, description: string): CommandSpec => ({
  name,
  description,
  metadata: {},
  body: "body",
  path: `/x/${name}.md`,
  extra: {},
});

describe("createCommandRegistry", () => {
  test("get / has / list", () => {
    const reg = createCommandRegistry([cmd("a", "first"), cmd("b", "second")]);
    expect(reg.has("a")).toBe(true);
    expect(reg.has("missing")).toBe(false);
    expect(reg.get("b")?.description).toBe("second");
    expect(reg.get("missing")).toBeUndefined();
    expect(
      reg
        .list()
        .map((c) => c.name)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  test("first-wins dedup on duplicate names", () => {
    const reg = createCommandRegistry([cmd("a", "kept"), cmd("a", "shadowed")]);
    expect(reg.get("a")?.description).toBe("kept");
    expect(reg.list()).toHaveLength(1);
  });
});
