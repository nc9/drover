/**
 * Discriminated union for an MCP server configuration. Drover parses
 * this into a connected client at runtime startup; the `id` is the
 * server label used everywhere (allowlist key, tool prefix, error
 * messages).
 */
export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpStdioConfig {
  id: string;
  transport: "stdio";
  /** Executable to spawn. Resolved against PATH. */
  command: string;
  args?: ReadonlyArray<string>;
  /**
   * Extra env vars for the spawned process. Merged onto the inherited
   * environment (`MCP_*`, `PATH`, etc.). Pass `null` for a value to drop
   * that var entirely.
   */
  env?: Readonly<Record<string, string | null>>;
  /** Working directory. Defaults to drover's cwd. */
  cwd?: string;
}

export interface McpHttpConfig {
  id: string;
  /** `"http"` covers both Streamable-HTTP and SSE (auto-negotiated). */
  transport: "http";
  url: string;
  headers?: Readonly<Record<string, string>>;
}

/** Server descriptor surfaced to observers / diagnostics. */
export interface McpServerInfo {
  id: string;
  transport: McpServerConfig["transport"];
  /** Number of tools exposed after connection + `listTools`. */
  toolCount: number;
}

/** Prefix every tool name so cross-server collisions don't ambush composition. */
export function prefixedToolName(serverId: string, toolName: string): string {
  return `${serverId}__${toolName}`;
}

/** Inverse of `prefixedToolName` — used for routing back to the right server. */
export function parsePrefixedToolName(
  prefixed: string,
): { serverId: string; toolName: string } | null {
  const i = prefixed.indexOf("__");
  if (i <= 0) return null;
  return { serverId: prefixed.slice(0, i), toolName: prefixed.slice(i + 2) };
}
