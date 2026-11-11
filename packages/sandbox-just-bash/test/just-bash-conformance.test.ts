import { describe, test } from "bun:test";
import { sandboxConformanceCases } from "@droveragent/sandbox";

import { createJustBashSandbox } from "../src/index.ts";

describe("just-bash adapter conformance", () => {
  for (const c of sandboxConformanceCases({ expectShell: true })) {
    test(c.name, async () => {
      await c.run({ adapter: createJustBashSandbox(), workdir: "/home/user" });
    });
  }
});
