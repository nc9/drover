import { describe, test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createPromptEngine, loadPromptFile } from "../src/index.ts";

describe("loadPromptFile", () => {
  test("reads a .md.liquid file verbatim", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "drover-loader-"));
    const file = path.join(dir, "system.md.liquid");
    const body = "You are {% agent %}.\n";
    await fs.writeFile(file, body);
    expect(await loadPromptFile(file)).toBe(body);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("a plain .md file with no tags round-trips through the engine", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "drover-loader-"));
    const file = path.join(dir, "notes.md");
    const body = "# Notes\n\nNo template tags at all.\n";
    await fs.writeFile(file, body);
    const r = await createPromptEngine().renderFile(file, {});
    expect(r.text).toBe(body);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
