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
];

const BY_NAME: ReadonlyMap<string, Builtin> = new Map(BUILTINS.map((b) => [b.name, b]));

export function getBuiltin(name: string): Builtin | undefined {
  return BY_NAME.get(name);
}
