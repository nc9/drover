import { describe, expect, test } from "bun:test";

import { droverVersions } from "../src/index.ts";

describe("droverVersions", () => {
  test("lists loaded packages by name; two copies of one package show both versions", () => {
    const registry = (globalThis as unknown as Record<symbol, Map<string, Set<string>>>)[
      Symbol.for("droveragent.versions")
    ]!;
    // core registered itself when its entry was imported (unbuilt here: "source").
    expect(droverVersions()["@droveragent/core"]).toBe("source");
    registry.set("@droveragent/test-a", new Set(["0.3.0"]));
    registry.set("@droveragent/test-b", new Set(["0.3.0", "0.3.0+local.1a2b3c4"]));
    const v = droverVersions();
    expect(v["@droveragent/test-a"]).toBe("0.3.0");
    expect(v["@droveragent/test-b"]).toBe("0.3.0, 0.3.0+local.1a2b3c4");
    expect(Object.keys(v)).toEqual(Object.keys(v).toSorted());
    registry.delete("@droveragent/test-a");
    registry.delete("@droveragent/test-b");
  });
});
