import { describe, test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createPromptEngine } from "../src/index.ts";

describe("createPromptEngine — render", () => {
  test("plain markdown with no tags renders verbatim", async () => {
    const engine = createPromptEngine();
    const src = "# Title\n\nJust markdown, no directives.\n";
    const r = await engine.render(src, {});
    expect(r.text).toBe(src);
  });

  test("{{ }} slots resolve from vars", async () => {
    const engine = createPromptEngine();
    const r = await engine.render("Hello {{ who }}.", { vars: { who: "world" } });
    expect(r.text).toBe("Hello world.");
  });

  test("Liquid filters and {% if %} control flow work", async () => {
    const engine = createPromptEngine();
    const r = await engine.render("{{ who | upcase }}{% if flag %} ON{% endif %}", {
      vars: { who: "drover", flag: true },
    });
    expect(r.text).toBe("DROVER ON");
  });

  test("{% date %} renders a YYYY-MM-DD date", async () => {
    const engine = createPromptEngine();
    const r = await engine.render("{% date %}", {});
    expect(r.text).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('{% agent %} renders id, field:"name" renders name', async () => {
    const engine = createPromptEngine();
    const scope = { agent: { id: "a1", name: "Agent One" } };
    expect((await engine.render("{% agent %}", scope)).text).toBe("a1");
    expect((await engine.render('{% agent field: "name" %}', scope)).text).toBe("Agent One");
  });

  test("a builtin with no backing scope data renders empty", async () => {
    const engine = createPromptEngine();
    const r = await engine.render("[{% skills %}{% instructions %}{% model %}]", {});
    expect(r.text).toBe("[]");
  });

  test("renderFile reads a template from disk", async () => {
    const engine = createPromptEngine();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "drover-prompt-"));
    const file = path.join(dir, "system.md.liquid");
    await fs.writeFile(file, "Agent {{ who }}.");
    const r = await engine.renderFile(file, { vars: { who: "X" } });
    expect(r.text).toBe("Agent X.");
    await fs.rm(dir, { recursive: true, force: true });
  });
});
