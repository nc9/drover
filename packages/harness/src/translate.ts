import type { AnyToolDef, HarnessEvent, ToolResult } from "@drover/core";
import { Effect } from "effect";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Static, TSchema } from "@sinclair/typebox";

/**
 * Wrap a drover `ToolDef` so pi-agent-core can call it. The pi side
 * expects (toolCallId, params, signal?) → Promise<AgentToolResult>;
 * we run drover's Effect-based execute under the hood.
 */
export function toPiTool(
  tool: AnyToolDef,
  buildCtx: (toolCallId: string, signal?: AbortSignal) => {
    runId: string;
    cwd: string;
    env: Readonly<Record<string, string>>;
    signal: AbortSignal;
    run: import("@drover/core").RunContext;
  },
): AgentTool<TSchema> {
  return {
    name: tool.id,
    description: tool.description,
    parameters: tool.inputSchema,
    label: tool.id,
    execute: async (
      toolCallId: string,
      params: Static<TSchema>,
      signal?: AbortSignal,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; terminate?: boolean }> => {
      const base = buildCtx(toolCallId, signal);
      const ctx = {
        runId: base.runId,
        toolUseId: toolCallId,
        cwd: base.cwd,
        env: base.env,
        signal: base.signal,
        run: base.run,
      };
      const result: ToolResult = await Effect.runPromise(
        tool.execute(params, ctx) as Effect.Effect<ToolResult, never, never>,
      );
      if (result.isError) {
        // Pi-agent-core expects tools to throw on failure for the
        // model to see `is_error: true`. Wrap the message so callers
        // can still observe the structured data via the thrown error.
        throw new Error(result.content);
      }
      return {
        content: [{ type: "text", text: result.content }],
        details: result.data ?? null,
      };
    },
  };
}

/**
 * Translate pi-agent-core's `AgentEvent` stream into drover `HarnessEvent`s.
 * One pi event may produce 0..N drover events.
 *
 * Stateful: `turn` is incremented on each `turn_start`; tool-call start
 * timestamps are remembered so `tool_call_end` can include `durationMs`.
 */
export function createTranslator(
  runId: string,
  initialTurn = 0,
): {
  translate: (e: PiEvent) => HarnessEvent[];
  currentTurn: () => number;
} {
  let turn = initialTurn;
  const toolStartedAt = new Map<string, number>();

  const translate = (e: PiEvent): HarnessEvent[] => {
    const ts = Date.now();
    switch (e.type) {
      case "agent_start":
        return [];
      case "turn_start": {
        turn += 1;
        return [{ kind: "turn_start", runId, turn, ts }];
      }
      case "message_end": {
        const msg = e.message;
        if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
          const events: HarnessEvent[] = [];
          for (const c of msg.content) {
            if (c && typeof c === "object" && (c as { type?: string }).type === "text") {
              const text = (c as { text?: string }).text ?? "";
              events.push({ kind: "assistant_text", runId, turn, text, ts });
            } else if (c && typeof c === "object" && (c as { type?: string }).type === "thinking") {
              const text = (c as { thinking?: string }).thinking ?? "";
              events.push({ kind: "thinking", runId, turn, text, ts });
            }
          }
          // Carry usage when the assistant message tags it.
          const usage = (msg as { usage?: { input?: number; output?: number; cost?: { total?: number } } }).usage;
          if (usage && (usage.input || usage.output)) {
            const u: { inputTokens: number; outputTokens: number; costUsd?: number } = {
              inputTokens: usage.input ?? 0,
              outputTokens: usage.output ?? 0,
            };
            if (usage.cost?.total !== undefined) u.costUsd = usage.cost.total;
            events.push({ kind: "usage", runId, turn, usage: u, ts });
          }
          return events;
        }
        return [];
      }
      case "tool_execution_start": {
        const toolCallId = e.toolCallId ?? "";
        const toolName = e.toolName ?? "";
        toolStartedAt.set(toolCallId, ts);
        return [
          {
            kind: "tool_call_start",
            runId,
            turn,
            toolUseId: toolCallId,
            toolName,
            input: e.args,
            ts,
          },
        ];
      }
      case "tool_execution_end": {
        const toolCallId = e.toolCallId ?? "";
        const toolName = e.toolName ?? "";
        const startedAt = toolStartedAt.get(toolCallId) ?? ts;
        toolStartedAt.delete(toolCallId);
        const result = extractToolResult(e.result, e.isError ?? false);
        return [
          {
            kind: "tool_call_end",
            runId,
            turn,
            toolUseId: toolCallId,
            toolName,
            result,
            durationMs: ts - startedAt,
            ts,
          },
        ];
      }
      case "agent_end":
      case "turn_end":
      case "message_start":
      case "message_update":
      case "tool_execution_update":
        return [];
      default:
        return [];
    }
  };

  return { translate, currentTurn: (): number => turn };
}

function extractToolResult(raw: unknown, isError: boolean): ToolResult {
  if (raw && typeof raw === "object" && "content" in raw) {
    const content = (raw as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((c) => (c && typeof c === "object" && (c as { text?: string }).text) || "")
        .join("");
      return { content: text, isError, data: (raw as { details?: unknown }).details };
    }
  }
  if (typeof raw === "string") return { content: raw, isError };
  return { content: JSON.stringify(raw), isError };
}

/** Loose pi-event shape — drives `translate` without importing the full deep type. */
export type PiEvent = {
  type: string;
  message?: { role?: string; content?: unknown; usage?: unknown };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
} & {
  type:
    | "agent_start"
    | "agent_end"
    | "turn_start"
    | "turn_end"
    | "message_start"
    | "message_update"
    | "message_end"
    | "tool_execution_start"
    | "tool_execution_update"
    | "tool_execution_end";
};
