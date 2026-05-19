import { describe, test, expect } from "bun:test";
import { Type } from "@sinclair/typebox";
import { defineAgent } from "@drover/core";

import { hashSpec } from "../src/index.ts";

const baseSpec = defineAgent({
  id: "x",
  systemPrompt: "p",
  inputSchema: Type.Object({ q: Type.String() }),
  outputSchema: Type.Object({ a: Type.String() }),
  model: "cheap",
  tools: ["bash"],
  maxTurns: 5,
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

  test("maxTurns drift produces different hash", () => {
    const other = { ...baseSpec, maxTurns: 10 };
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
});
