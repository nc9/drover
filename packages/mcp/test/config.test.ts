import { describe, test, expect } from "bun:test";
import { prefixedToolName, parsePrefixedToolName } from "../src/index.ts";

describe("prefixedToolName", () => {
  test("composes server + tool with double-underscore separator", () => {
    expect(prefixedToolName("srv", "tool")).toBe("srv__tool");
  });

  test("survives round-trip via parsePrefixedToolName", () => {
    const r = parsePrefixedToolName("srv__some_tool");
    expect(r?.serverId).toBe("srv");
    expect(r?.toolName).toBe("some_tool");
  });

  test("parsePrefixedToolName returns null for malformed names", () => {
    expect(parsePrefixedToolName("no-prefix")).toBeNull();
    expect(parsePrefixedToolName("__missing-server")).toBeNull();
  });

  test("splits at the first __ even if tool name contains more __", () => {
    const r = parsePrefixedToolName("server__tool__with__double");
    expect(r?.serverId).toBe("server");
    expect(r?.toolName).toBe("tool__with__double");
  });
});
