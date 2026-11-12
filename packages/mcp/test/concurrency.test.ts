/** `concurrencySafe` (#29): MCP tools are sequential unless the server config marks them safe. */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createMcpRuntime } from "../src/index.ts";

const FIXTURE = join(import.meta.dir, "../../../evals/fixtures/mcp-stdio/server.ts");

const toolsWith = async (concurrencySafe?: boolean | string[]) => {
  const rt = await createMcpRuntime([
    {
      id: "fx",
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      ...(concurrencySafe !== undefined ? { concurrencySafe } : {}),
    },
  ]);
  try {
    return rt.tools().map((t) => [t.id, t.concurrency ?? null] as const);
  } finally {
    await rt.close();
  }
};

describe("MCP tool concurrency", () => {
  test("default: no MCP tool is concurrency-safe", async () => {
    const tools = await toolsWith();
    expect(tools.length).toBeGreaterThan(1);
    expect(tools.every(([, c]) => c === null)).toBe(true);
  });

  test("true marks every tool of the server; a list marks only the named (unprefixed) tools", async () => {
    expect((await toolsWith(true)).every(([, c]) => c === "safe")).toBe(true);
    const all = await toolsWith();
    const first = all[0]![0].replace(/^fx__/, "");
    const listed = await toolsWith([first]);
    for (const [id, c] of listed) expect(c).toBe(id === `fx__${first}` ? "safe" : null);
  });
});
