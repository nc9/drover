import { describe, test, expect } from "bun:test";

import { createPromptEngine } from "../src/index.ts";

describe("analyze (compile-time)", () => {
  test("an all-static template has a full cacheable prefix and no warnings", () => {
    const engine = createPromptEngine();
    const report = engine.analyze("Static intro.\n{% instructions %}\nMore static.\n");
    expect(report.cacheablePrefixChars).toBeGreaterThan(0);
    expect(report.warnings).toHaveLength(0);
    expect(report.reordered).toBe(false);
  });

  test("a volatile builtin before static content kills the prefix and warns", () => {
    const engine = createPromptEngine();
    const report = engine.analyze("{% date %}\nStatic after the date.\n");
    expect(report.cacheablePrefixChars).toBe(0);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]!.builtin).toBe("date");
  });

  test("a control tag is volatile — its scope-dependent output cannot be cached", () => {
    const engine = createPromptEngine();
    const report = engine.analyze("{% if flag %}X{% endif %}\nStatic content.\n");
    expect(report.cacheablePrefixChars).toBe(0);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]!.builtin).toBeUndefined();
  });
});

describe("render — cache report", () => {
  test("without autoReorder a leading {% date %} leaves a zero-length prefix", async () => {
    const engine = createPromptEngine();
    const r = await engine.render("{% date %}\nStatic tail line.\n", {});
    expect(r.cache.reordered).toBe(false);
    expect(r.cache.cacheablePrefixChars).toBe(0);
    expect(r.cache.warnings).toHaveLength(1);
    expect(r.text).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  test("autoReorder moves a volatile builtin to the footer", async () => {
    const engine = createPromptEngine();
    const r = await engine.render("{% date %}\nStatic tail line.\n", {}, { autoReorder: true });
    expect(r.cache.reordered).toBe(true);
    expect(r.cache.cacheablePrefixChars).toBeGreaterThan(0);
    expect(r.text).toContain("Static tail line.");
    expect(r.text.trimEnd()).toMatch(/\d{4}-\d{2}-\d{2}$/);
  });

  test("autoReorder does not move a volatile builtin across an {% if %} barrier", async () => {
    const engine = createPromptEngine();
    // {% date %} sits before the conditional; it must move to the end of
    // the leading segment but stay before the {% if %} block — never past it.
    const src = "{% date %}\nMiddle static.\n{% if flag %}KEEP-BODY{% endif %}\nTail.\n";
    const r = await engine.render(src, { vars: { flag: true } }, { autoReorder: true });
    expect(r.cache.reordered).toBe(true);
    expect(r.text).toContain("KEEP-BODY");
    expect(r.text).toContain("Middle static.");
    expect(r.text).toContain("Tail.");
    const dateAt = r.text.search(/\d{4}-\d{2}-\d{2}/);
    // date moved after the leading static, but still before the {% if %} body.
    expect(r.text.indexOf("Middle static.")).toBeLessThan(dateAt);
    expect(dateAt).toBeLessThan(r.text.indexOf("KEEP-BODY"));
  });

  test("a leading control tag blocks reorder entirely", async () => {
    const engine = createPromptEngine();
    // {% if %} is the first node — the leading segment is empty, so there
    // is nothing to reorder even though {% date %} follows.
    const src = "{% if flag %}X{% endif %}\nStatic.\n{% date %}\n";
    const r = await engine.render(src, { vars: { flag: true } }, { autoReorder: true });
    expect(r.cache.reordered).toBe(false);
  });

  test("a {{ }} slot is volatile but never moved by autoReorder", async () => {
    const engine = createPromptEngine();
    const r = await engine.render(
      "{{ slot }}\nStatic content here.\n",
      { vars: { slot: "V" } },
      { autoReorder: true },
    );
    expect(r.cache.reordered).toBe(false);
    expect(r.cache.warnings).toHaveLength(1);
    expect(r.cache.warnings[0]!.builtin).toBeUndefined();
    expect(r.text).toMatch(/^V/);
  });
});
