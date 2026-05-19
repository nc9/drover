#!/usr/bin/env bun
// Fixture MCP stdio server used by the mcp-roundtrip eval. Exposes two
// tools that are easy to verify end-to-end:
//   - compute({expression}): evaluate a small arithmetic expression
//   - weather({city}): canned answer keyed on a known city
//
// Spawned by drover via StdioClientTransport. Bun starts fast enough
// that test latency is dominated by the LLM, not server boot.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "drover-eval-fixture", version: "0.0.0" });

server.registerTool(
  "compute",
  {
    title: "Evaluate arithmetic",
    description:
      "Evaluate a simple arithmetic expression. Supports +, -, *, /, parentheses, and decimal numbers. No variables.",
    inputSchema: { expression: z.string().describe("e.g. '2 + 3 * (4 - 1)'") },
  },
  async ({ expression }) => {
    try {
      const value = evaluateArithmetic(expression);
      return { content: [{ type: "text", text: String(value) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `eval failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "weather",
  {
    title: "Lookup canned weather",
    description: "Get today's weather for a known city. Returns a one-line summary.",
    inputSchema: { city: z.string() },
  },
  async ({ city }) => {
    const map: Record<string, string> = {
      lisbon: "Lisbon: 19C, sunny with a sea breeze.",
      london: "London: 12C, overcast with light drizzle.",
      sydney: "Sydney: 24C, clear skies.",
    };
    const hit = map[city.toLowerCase().trim()];
    return {
      content: [{ type: "text", text: hit ?? `Unknown city: ${city}` }],
      isError: !hit,
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

// ── tiny recursive-descent arithmetic parser ────────────────────────
// Grammar: expr := term (("+"|"-") term)* ; term := factor (("*"|"/") factor)* ;
//          factor := number | "(" expr ")" | "-" factor

function evaluateArithmetic(input: string): number {
  if (!/^[\d\s+\-*/().]+$/.test(input)) {
    throw new Error(`bad characters in expression: ${input}`);
  }
  let i = 0;
  const skipWs = (): void => {
    while (i < input.length && input[i] === " ") i++;
  };
  const parseNumber = (): number => {
    skipWs();
    const start = i;
    while (i < input.length && /[0-9.]/.test(input[i]!)) i++;
    const lit = input.slice(start, i);
    const n = Number(lit);
    if (Number.isNaN(n)) throw new Error(`not a number at ${start}: '${lit}'`);
    return n;
  };
  const parseFactor = (): number => {
    skipWs();
    if (input[i] === "(") {
      i++;
      const v = parseExpr();
      skipWs();
      if (input[i] !== ")") throw new Error(`missing ) at ${i}`);
      i++;
      return v;
    }
    if (input[i] === "-") {
      i++;
      return -parseFactor();
    }
    return parseNumber();
  };
  const parseTerm = (): number => {
    let v = parseFactor();
    while (true) {
      skipWs();
      const op = input[i];
      if (op === "*" || op === "/") {
        i++;
        const rhs = parseFactor();
        v = op === "*" ? v * rhs : v / rhs;
      } else break;
    }
    return v;
  };
  function parseExpr(): number {
    let v = parseTerm();
    while (true) {
      skipWs();
      const op = input[i];
      if (op === "+" || op === "-") {
        i++;
        const rhs = parseTerm();
        v = op === "+" ? v + rhs : v - rhs;
      } else break;
    }
    return v;
  }
  const result = parseExpr();
  skipWs();
  if (i !== input.length) throw new Error(`trailing input at ${i}`);
  return result;
}
