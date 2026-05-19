import { Type, type TSchema } from "@sinclair/typebox";
import {
  type AnyToolDef,
  defineTool,
  SandboxError,
  type ToolResult,
} from "@drover/core";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  type McpServerConfig,
  type McpServerInfo,
  prefixedToolName,
} from "./config.ts";

/**
 * Live MCP runtime. Holds connected `Client` instances and the flat
 * list of prefixed tools they expose. `tools(allowed)` filters by
 * server allowlist for use during `composeTools` in the harness.
 */
export interface McpRuntime {
  /** Tools surfaced to drover, prefixed `<serverId>__<toolName>`. */
  tools(allowed?: ReadonlyArray<string>): ReadonlyArray<AnyToolDef>;
  /** Loaded server info — handy for system-prompt advertisement / debugging. */
  servers(): ReadonlyArray<McpServerInfo>;
  /** Close all connected transports + clients. */
  close(): Promise<void>;
}

interface ConnectedServer {
  id: string;
  client: Client;
  transport: McpServerConfig["transport"];
  tools: AnyToolDef[];
}

/**
 * Connect every configured MCP server in parallel, list its tools, and
 * wrap them as drover `ToolDef`s. Tool execution proxies back through
 * the live `Client.callTool(...)`.
 *
 * Errors per server are isolated: one failed connect does NOT block
 * the others. Failed servers contribute zero tools and surface in
 * `servers()` with `toolCount: 0`.
 */
export async function createMcpRuntime(
  configs: ReadonlyArray<McpServerConfig>,
): Promise<McpRuntime> {
  const connected: ConnectedServer[] = await Promise.all(
    configs.map(async (cfg): Promise<ConnectedServer> => {
      try {
        const client = new Client({ name: `drover/${cfg.id}`, version: "0.0.0" });
        const transport = buildTransport(cfg);
        await client.connect(transport);
        const list = await client.listTools();
        const tools = list.tools.map((t) => mcpToolToDroverTool(cfg.id, client, t));
        return { id: cfg.id, client, transport: cfg.transport, tools };
      } catch (err) {
        // Surface as zero-tool server; consumers see it in servers() output.
        console.error(`[mcp] server ${cfg.id} failed to connect: ${(err as Error).message}`);
        return {
          id: cfg.id,
          client: null as unknown as Client,
          transport: cfg.transport,
          tools: [],
        };
      }
    }),
  );

  return {
    tools: (allowed): ReadonlyArray<AnyToolDef> => {
      if (!allowed) return connected.flatMap((s) => s.tools);
      const allow = new Set(allowed);
      return connected.filter((s) => allow.has(s.id)).flatMap((s) => s.tools);
    },
    servers: (): ReadonlyArray<McpServerInfo> =>
      connected.map((s) => ({ id: s.id, transport: s.transport, toolCount: s.tools.length })),
    close: async (): Promise<void> => {
      await Promise.allSettled(
        connected.map(async (s) => {
          if (s.client) await s.client.close().catch(() => {});
        }),
      );
    },
  };
}

type Transport = import("@modelcontextprotocol/sdk/shared/transport.js").Transport;

function buildTransport(cfg: McpServerConfig): Transport {
  if (cfg.transport === "stdio") {
    // Filter null entries — those mean "drop from env". SDK accepts a
    // plain Record<string,string>; we mirror its expectation.
    const env: Record<string, string> = {};
    if (cfg.env) {
      for (const [k, v] of Object.entries(cfg.env)) {
        if (typeof v === "string") env[k] = v;
      }
    }
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ? [...cfg.args] : [],
      ...(cfg.env ? { env } : {}),
      ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
    });
  }
  // SDK's `Transport.sessionId` is typed `string` but the StreamableHTTP
  // implementation populates it lazily as `string | undefined`. Cast around
  // the exactOptionalPropertyTypes mismatch.
  return new StreamableHTTPClientTransport(new URL(cfg.url), {
    ...(cfg.headers
      ? { requestInit: { headers: { ...cfg.headers } } }
      : {}),
  }) as unknown as Transport;
}

interface McpToolDescriptor {
  name: string;
  description?: string | undefined;
  inputSchema?: unknown;
}

function mcpToolToDroverTool(
  serverId: string,
  client: Client,
  tool: McpToolDescriptor,
): AnyToolDef {
  // The MCP tool's JSON Schema is preserved verbatim via Type.Unsafe so the
  // LLM sees the right arg shape; server-side enforcement is the source of
  // truth for validation.
  const schema: TSchema = (tool.inputSchema && typeof tool.inputSchema === "object"
    ? Type.Unsafe(tool.inputSchema)
    : Type.Object({}, { additionalProperties: true })) as TSchema;

  const prefixed = prefixedToolName(serverId, tool.name);
  return defineTool({
    id: prefixed,
    description: tool.description ?? `MCP tool ${tool.name} on server ${serverId}`,
    inputSchema: schema,
    execute: (input, ctx): Effect.Effect<ToolResult, SandboxError, never> =>
      Effect.tryPromise({
        try: async (): Promise<ToolResult> => {
          const result = await client.callTool({
            name: tool.name,
            arguments: input as Record<string, unknown>,
          });
          const text = extractText(result);
          return {
            content: text,
            isError: Boolean((result as { isError?: boolean }).isError),
            data: result,
          };
        },
        catch: (err): SandboxError =>
          new SandboxError({
            runId: ctx.runId,
            op: "exec",
            message: `mcp ${prefixed} failed: ${(err as Error).message}`,
          }),
      }),
  });
}

function extractText(result: unknown): string {
  if (!result || typeof result !== "object") return JSON.stringify(result);
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object") {
      const t = (c as { type?: string }).type;
      if (t === "text") {
        const txt = (c as { text?: unknown }).text;
        if (typeof txt === "string") parts.push(txt);
      } else if (t === "image") {
        parts.push("[image]");
      } else {
        parts.push(JSON.stringify(c));
      }
    }
  }
  return parts.join("\n");
}
