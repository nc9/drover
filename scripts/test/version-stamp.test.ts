import { describe, expect, test } from "bun:test";

import { stampedVersionIn } from "../release-lib.ts";
import { UNSTAMPED, stampedVersion } from "../postbuild-version.ts";

describe("build version stamp", () => {
  test("a release build is the plain version; any other build says +local", () => {
    expect(stampedVersion("0.3.0-next.1", true, "1a2b3c4")).toBe("0.3.0-next.1");
    expect(stampedVersion("0.3.0", false, "1a2b3c4")).toBe("0.3.0+local.1a2b3c4");
    expect(stampedVersion("0.3.0", false, "1a2b3c4.dirty")).toBe("0.3.0+local.1a2b3c4.dirty");
    expect(stampedVersion("0.3.0", false, null)).toBe("0.3.0+local");
  });

  test("the release check reads the stamp back from dist/version.js", () => {
    expect(stampedVersionIn('const a = 1;\nexport const version = "0.3.0";\n')).toBe("0.3.0");
    expect(stampedVersionIn('export const version = "0.3.0+local.1a2b3c4";')).toBe(
      "0.3.0+local.1a2b3c4",
    );
    expect(stampedVersionIn(UNSTAMPED)).toBe("source");
    expect(stampedVersionIn("export {};")).toBeUndefined();
  });

  test("every package's src/version.ts starts unstamped with the literal the stamper replaces", async () => {
    const { workspacePackages, packageDir } = await import("../workspace.ts");
    for (const pkg of workspacePackages()) {
      const src = await Bun.file(`${packageDir(pkg)}/src/version.ts`).text();
      expect(src).toContain('export const version: string = "source";');
      const index = await Bun.file(`${packageDir(pkg)}/src/index.ts`).text();
      expect(index).toContain('import "./version.ts";');
    }
  });
});
