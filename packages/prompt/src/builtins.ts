import { renderInstructionsBlock, renderMemoryIndex } from "@drover/memory";
import { renderSkillsBlock } from "@drover/skills";
import { Effect } from "effect";

import type { Builtin } from "./types.ts";

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function fmtDate(format?: string): string {
  const now = new Date();
  if (format === "iso") return now.toISOString();
  if (format === "unix") return String(Math.floor(now.getTime() / 1000));
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function fmtTime(format?: string): string {
  const now = new Date();
  if (format === "iso") return now.toISOString();
  return now.toISOString().slice(11, 19); // HH:MM:SS
}

/**
 * The drover builtin registry. Each entry is registered as a custom
 * Liquid tag (`{% name %}`); volatility drives the cache analyzer.
 *
 * A builtin whose backing scope field is absent renders `""` — callers
 * can drop a `{% memory %}` into any template without guarding it.
 */
export const BUILTINS: ReadonlyArray<Builtin> = [
  {
    name: "instructions",
    volatility: "static",
    render: (scope) => renderInstructionsBlock(scope.instructions ?? []),
  },
  {
    name: "skills",
    volatility: "static",
    render: (scope) =>
      scope.skills ? renderSkillsBlock(scope.skills.registry, scope.skills.allowed) : "",
  },
  {
    name: "memory",
    volatility: "volatile",
    render: async (scope, hash) => {
      if (!scope.memory) return "";
      const limit = typeof hash.limit === "number" ? hash.limit : scope.memory.maxEntries;
      return await Effect.runPromise(
        renderMemoryIndex(
          scope.memory.adapter,
          scope.memory.agentId,
          limit !== undefined ? { maxEntries: limit } : {},
        ),
      );
    },
  },
  {
    name: "agent",
    volatility: "static",
    render: (scope, hash) => {
      if (!scope.agent) return "";
      return asString(hash.field) === "name"
        ? (scope.agent.name ?? scope.agent.id)
        : scope.agent.id;
    },
  },
  {
    name: "cwd",
    volatility: "static",
    render: (scope) => scope.run?.cwd ?? "",
  },
  {
    name: "runId",
    volatility: "volatile",
    render: (scope) => scope.run?.runId ?? "",
  },
  {
    name: "model",
    volatility: "static",
    render: (scope) => scope.model ?? "",
  },
  {
    name: "tools",
    volatility: "static",
    render: (scope, hash) => (scope.tools ?? []).join(asString(hash.sep) ?? ", "),
  },
  {
    name: "date",
    volatility: "volatile",
    render: (_scope, hash) => fmtDate(asString(hash.format)),
  },
  {
    name: "time",
    volatility: "volatile",
    render: (_scope, hash) => fmtTime(asString(hash.format)),
  },
  {
    // Capability fragment — explains the `task` tool + lists spawnable
    // agents. Emitted when the spec declares `subagents` and a registry is
    // wired. Static: the registry + caps don't change across runs.
    name: "subagents",
    volatility: "static",
    render: (scope) => {
      const s = scope.subagents;
      if (!s || s.allowed.length === 0) return "";
      const lines = s.allowed.map((a) =>
        a.description ? `- ${a.id}: ${a.description}` : `- ${a.id}`,
      );
      return [
        "## Subagents",
        "",
        "Delegate work to a child agent with the `task` tool — use it when a subtask",
        "needs a different role, tool set, or model than yours. Pass `agent_type` (one",
        "of the ids below), a `prompt`, and optionally a JSON `input`.",
        "",
        "Spawnable agents:",
        "",
        ...lines,
        "",
        `Limits: nesting depth ${s.maxDepth}, up to ${s.fanOut} concurrent children per agent.`,
      ].join("\n");
    },
  },
  {
    // Capability fragment — names connected MCP servers + their prefixed
    // tools, and explains the `<serverId>__<toolName>` convention. Emitted
    // when the spec declares `mcpServers` and a runtime is wired.
    name: "mcp",
    volatility: "static",
    render: (scope) => {
      const m = scope.mcp;
      if (!m || m.servers.length === 0) return "";
      const out: string[] = [
        "## MCP servers",
        "",
        "Tools from connected MCP servers are in your toolset. Their names are",
        "prefixed `<serverId>__<toolName>` so they never collide — call them by the",
        "full prefixed name.",
        "",
      ];
      for (const srv of m.servers) {
        out.push(`### ${srv.id}`, "");
        if (srv.tools.length === 0) {
          out.push("(no tools available)", "");
        } else {
          for (const t of srv.tools) out.push(`- ${t}`);
          out.push("");
        }
      }
      return out.join("\n").trimEnd();
    },
  },
  {
    // Capability fragment — execution facts (cwd, model, sandbox, date).
    // Volatile because it carries the date; the cache analyzer keeps the
    // whole block out of the cacheable prefix.
    name: "environment",
    volatility: "volatile",
    render: (scope) => {
      const cwd = scope.run?.cwd;
      const model = scope.model;
      const sandboxId = scope.environment?.sandboxId;
      const lines: string[] = [];
      if (cwd) lines.push(`- Working directory: ${cwd}`);
      if (model) lines.push(`- Model: ${model}`);
      if (sandboxId) lines.push(`- Sandbox: ${sandboxId}`);
      lines.push(`- Date: ${fmtDate()}`);
      return ["## Environment", "", ...lines].join("\n");
    },
  },
];

/**
 * The builtin-tag layout the harness renders for the default (non-template)
 * assembly path. The author's `systemPrompt` is concatenated as plain text
 * BEFORE this is rendered — it is never Liquid-parsed. Every tag renders
 * `""` when its mechanism is absent, so empty blocks collapse cleanly once
 * the harness normalises blank-line runs. Static tags first, volatile last,
 * so the cacheable prefix stays maximal.
 */
export const DEFAULT_PROMPT_TEMPLATE: string = [
  "{% instructions %}",
  "{% skills %}",
  "{% subagents %}",
  "{% mcp %}",
  "{% memory %}",
  "{% environment %}",
].join("\n\n");

const BY_NAME: ReadonlyMap<string, Builtin> = new Map(BUILTINS.map((b) => [b.name, b]));

export function getBuiltin(name: string): Builtin | undefined {
  return BY_NAME.get(name);
}
