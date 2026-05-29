import { describe, test, expect } from "bun:test";
import { Type } from "@sinclair/typebox";
import { defineAgent } from "@droveragent/core";

import { hashSpec } from "../src/index.ts";

const baseSpec = defineAgent({
  id: "x",
  systemPrompt: "p",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Object({ a: Type.String() }),
  model: "cheap",
  tools: ["bash"],
  quota: { maxTurns: 5 },
  outputRetries: 2,
});

describe("hashSpec", () => {
  test("identical specs hash equal", () => {
    expect(hashSpec(baseSpec)).toBe(hashSpec(baseSpec));
  });

  test("returns hex string", () => {
    expect(hashSpec(baseSpec)).toMatch(/^[0-9a-f]+$/);
  });

  test("systemPrompt drift produces different hash", () => {
    const other = { ...baseSpec, systemPrompt: "different prompt" };
    expect(hashSpec(other)).not.toBe(hashSpec(baseSpec));
  });

  test("model drift produces different hash", () => {
    const other = { ...baseSpec, model: "haiku" };
    expect(hashSpec(other)).not.toBe(hashSpec(baseSpec));
  });

  test("tools drift produces different hash", () => {
    const other = { ...baseSpec, tools: ["bash", "read"] };
    expect(hashSpec(other)).not.toBe(hashSpec(baseSpec));
  });

  test("quota drift produces different hash", () => {
    const other = { ...baseSpec, quota: { maxTurns: 10 } };
    expect(hashSpec(other)).not.toBe(hashSpec(baseSpec));
  });

  test("outputRetries drift produces different hash", () => {
    const other = { ...baseSpec, outputRetries: 0 };
    expect(hashSpec(other)).not.toBe(hashSpec(baseSpec));
  });

  test("plugin set drift produces different hash", () => {
    const other = {
      ...baseSpec,
      plugins: [{ id: "p1" }, { id: "p2" }] as never,
    };
    expect(hashSpec(other)).not.toBe(hashSpec(baseSpec));
  });

  test("plugin id change is detected", () => {
    const a = { ...baseSpec, plugins: [{ id: "p1" }] as never };
    const b = { ...baseSpec, plugins: [{ id: "p2" }] as never };
    expect(hashSpec(a)).not.toBe(hashSpec(b));
  });

  test("fn-valued systemPrompt: source-level drift detected", () => {
    const a = { ...baseSpec, systemPrompt: () => "version-1" };
    const b = { ...baseSpec, systemPrompt: () => "version-2 DRIFTED" };
    expect(hashSpec(a)).not.toBe(hashSpec(b));
  });

  test("fn-valued systemPrompt: identical bodies hash equal", () => {
    const a = { ...baseSpec, systemPrompt: () => "stable" };
    const b = { ...baseSpec, systemPrompt: () => "stable" };
    expect(hashSpec(a)).toBe(hashSpec(b));
  });

  test("memory.enabled toggle changes the hash", () => {
    const off = { ...baseSpec, memory: { enabled: false } };
    const on = { ...baseSpec, memory: { enabled: true } };
    expect(hashSpec(off)).not.toBe(hashSpec(on));
  });

  test("memory.includeIndex toggle changes the hash", () => {
    const a = { ...baseSpec, memory: { enabled: true, includeIndex: true } };
    const b = { ...baseSpec, memory: { enabled: true, includeIndex: false } };
    expect(hashSpec(a)).not.toBe(hashSpec(b));
  });

  test("memory.allowForget toggle changes the hash", () => {
    const a = { ...baseSpec, memory: { enabled: true, allowForget: false } };
    const b = { ...baseSpec, memory: { enabled: true, allowForget: true } };
    expect(hashSpec(a)).not.toBe(hashSpec(b));
  });

  test("memory.writesPerTurn drift changes the hash", () => {
    const a = { ...baseSpec, memory: { enabled: true, writesPerTurn: 1 } };
    const b = { ...baseSpec, memory: { enabled: true, writesPerTurn: 3 } };
    expect(hashSpec(a)).not.toBe(hashSpec(b));
  });

  test("memory.maxIndexEntries drift changes the hash", () => {
    const a = { ...baseSpec, memory: { enabled: true, maxIndexEntries: 30 } };
    const b = { ...baseSpec, memory: { enabled: true, maxIndexEntries: 50 } };
    expect(hashSpec(a)).not.toBe(hashSpec(b));
  });

  test("adding instructionFiles changes the hash", () => {
    const off = { ...baseSpec };
    const on = { ...baseSpec, instructionFiles: {} };
    expect(hashSpec(off)).not.toBe(hashSpec(on));
  });

  test("instructionFiles config drift changes the hash", () => {
    const a = { ...baseSpec, instructionFiles: { filenames: ["AGENTS.md"] } };
    const b = { ...baseSpec, instructionFiles: { filenames: ["RULES.md"] } };
    expect(hashSpec(a)).not.toBe(hashSpec(b));
  });

  test("adding promptTemplate changes the hash", () => {
    const off = { ...baseSpec };
    const on = { ...baseSpec, promptTemplate: { source: "{% instructions %}" } };
    expect(hashSpec(off)).not.toBe(hashSpec(on));
  });

  test("promptTemplate config drift changes the hash", () => {
    const a = { ...baseSpec, promptTemplate: { source: "v1" } };
    const b = { ...baseSpec, promptTemplate: { source: "v2" } };
    expect(hashSpec(a)).not.toBe(hashSpec(b));
  });

  test("promptTemplate.autoReorder toggle changes the hash", () => {
    const a = { ...baseSpec, promptTemplate: { source: "x", autoReorder: false } };
    const b = { ...baseSpec, promptTemplate: { source: "x", autoReorder: true } };
    expect(hashSpec(a)).not.toBe(hashSpec(b));
  });

  test("commands allowlist drift changes the hash", () => {
    const a = { ...baseSpec, commands: ["setup"] };
    const b = { ...baseSpec, commands: ["setup", "lint"] };
    expect(hashSpec(a)).not.toBe(hashSpec(b));
  });

  test("lifecycle config drift changes the hash", () => {
    const a = { ...baseSpec, lifecycle: { init: [{ kind: "prompt", text: "x" } as const] } };
    const b = { ...baseSpec, lifecycle: { init: [{ kind: "prompt", text: "y" } as const] } };
    expect(hashSpec(a)).not.toBe(hashSpec(b));
  });

  test("adding a description changes the hash", () => {
    expect(hashSpec({ ...baseSpec, description: "a role" })).not.toBe(hashSpec(baseSpec));
  });

  test("description drift produces different hash", () => {
    const a = { ...baseSpec, description: "role A" };
    const b = { ...baseSpec, description: "role B" };
    expect(hashSpec(a)).not.toBe(hashSpec(b));
  });
});
