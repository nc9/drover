// Renders a drover HarnessEvent[] as a chat-style transcript.
// Each tool_call_start is paired with its tool_call_end by toolUseId
// so the result inlines under the call (or "running…" if unpaired,
// which happens for runs that errored mid-tool).

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Wrench, Sparkles, AlertCircle, Brain, Zap } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { HarnessEvent } from "@droveragent/core";
import { cn, formatUsd } from "../lib/format.ts";

type ParsedRow =
  | { kind: "run-start"; ts: number; agentId: string }
  | { kind: "input-validated"; ts: number }
  | { kind: "turn"; ts: number; turn: number }
  | { kind: "llm-call"; ts: number; turn: number; model: string; reasoning?: string }
  | { kind: "thinking"; ts: number; turn: number; text: string }
  | { kind: "assistant"; ts: number; turn: number; text: string }
  | {
      kind: "tool";
      ts: number;
      turn: number;
      toolUseId: string;
      toolName: string;
      input: unknown;
      result?: { content: string; isError: boolean; durationMs: number };
    }
  | { kind: "usage"; ts: number; turn: number; tokensIn: number; tokensOut: number; costUsd?: number }
  | { kind: "output-retry"; ts: number; attempt: number; reason: string }
  | { kind: "output-validated"; ts: number }
  | { kind: "subagent"; ts: number; childRunId: string; agentId?: string; phase: "start" | "end"; status?: string }
  | {
      kind: "memory-written";
      ts: number;
      id: string;
      scope: string;
      memKind: string;
      summary: string;
    }
  | {
      kind: "memory-recalled";
      ts: number;
      query: string | null;
      scopes: ReadonlyArray<string>;
      hits: ReadonlyArray<{ id: string; scope: string; score: number }>;
    }
  | { kind: "run-end"; ts: number; status: string }
  | { kind: "error"; ts: number; tag: string; message: string };

function parseEvents(events: ReadonlyArray<HarnessEvent>): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const pendingTools = new Map<string, ParsedRow & { kind: "tool" }>();

  for (const e of events) {
    switch (e.kind) {
      case "run_start":
        rows.push({ kind: "run-start", ts: e.ts, agentId: e.agentId });
        break;
      case "input_validated":
        rows.push({ kind: "input-validated", ts: e.ts });
        break;
      case "turn_start":
        rows.push({ kind: "turn", ts: e.ts, turn: e.turn });
        break;
      case "llm_call":
        rows.push({
          kind: "llm-call",
          ts: e.ts,
          turn: e.turn,
          model: e.modelName,
          ...(e.reasoning ? { reasoning: e.reasoning } : {}),
        });
        break;
      case "thinking":
        rows.push({ kind: "thinking", ts: e.ts, turn: e.turn, text: e.text });
        break;
      case "assistant_text":
        rows.push({ kind: "assistant", ts: e.ts, turn: e.turn, text: e.text });
        break;
      case "tool_call_start": {
        const row: ParsedRow & { kind: "tool" } = {
          kind: "tool",
          ts: e.ts,
          turn: e.turn,
          toolUseId: e.toolUseId,
          toolName: e.toolName,
          input: e.input,
        };
        pendingTools.set(e.toolUseId, row);
        rows.push(row);
        break;
      }
      case "tool_call_end": {
        const match = pendingTools.get(e.toolUseId);
        if (match) {
          match.result = {
            content: e.result.content,
            isError: Boolean(e.result.isError),
            durationMs: e.durationMs,
          };
          pendingTools.delete(e.toolUseId);
        }
        break;
      }
      case "usage":
        rows.push({
          kind: "usage",
          ts: e.ts,
          turn: e.turn,
          tokensIn: e.usage.inputTokens,
          tokensOut: e.usage.outputTokens,
          ...(e.usage.costUsd !== undefined ? { costUsd: e.usage.costUsd } : {}),
        });
        break;
      case "output_retry":
        rows.push({ kind: "output-retry", ts: e.ts, attempt: e.attempt, reason: e.reason });
        break;
      case "output_validated":
        rows.push({ kind: "output-validated", ts: e.ts });
        break;
      case "subagent_start":
        rows.push({ kind: "subagent", ts: e.ts, childRunId: e.childRunId, agentId: e.agentId, phase: "start" });
        break;
      case "subagent_end":
        rows.push({ kind: "subagent", ts: e.ts, childRunId: e.childRunId, phase: "end", status: e.status });
        break;
      case "memory_written":
        rows.push({
          kind: "memory-written",
          ts: e.ts,
          id: e.entry.id,
          scope: e.entry.scope,
          memKind: e.entry.kind,
          summary: e.entry.summary,
        });
        break;
      case "memory_recalled":
        rows.push({
          kind: "memory-recalled",
          ts: e.ts,
          query: e.query,
          scopes: e.scopes,
          hits: e.hits,
        });
        break;
      case "run_end":
        rows.push({ kind: "run-end", ts: e.ts, status: e.status });
        break;
      case "error":
        rows.push({ kind: "error", ts: e.ts, tag: e.tag, message: e.message });
        break;
      default:
        break;
    }
  }
  return rows;
}

export interface EventTimelineProps {
  events: ReadonlyArray<HarnessEvent>;
  startTs?: number;
}

export function EventTimeline({ events, startTs }: EventTimelineProps): React.ReactElement {
  const rows = useMemo(() => parseEvents(events), [events]);
  const t0 = startTs ?? rows[0]?.ts ?? Date.now();

  if (rows.length === 0) {
    return <div className="px-3 py-6 text-center text-xs text-zinc-500">no events recorded</div>;
  }

  return (
    <div className="divide-y divide-zinc-800/60">
      {rows.map((r, i) => (
        <Row key={i} row={r} t0={t0} />
      ))}
    </div>
  );
}

function Row({ row, t0 }: { row: ParsedRow; t0: number }): React.ReactElement | null {
  switch (row.kind) {
    case "run-start":
      return (
        <StatusChip
          icon={<Sparkles size={11} />}
          text={`agent started · ${row.agentId}`}
          relMs={row.ts - t0}
        />
      );
    case "input-validated":
      return <StatusChip icon={<FileText size={11} />} text="input validated" relMs={row.ts - t0} muted />;
    case "turn":
      return (
        <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-zinc-500 font-mono border-l-2 border-zinc-700/40 bg-zinc-900/40">
          turn {row.turn} · t+{((row.ts - t0) / 1000).toFixed(2)}s
        </div>
      );
    case "llm-call":
      return (
        <StatusChip
          icon={<Zap size={11} />}
          text={`llm · ${row.model}${row.reasoning ? ` · ${row.reasoning}` : ""}`}
          relMs={row.ts - t0}
          muted
        />
      );
    case "thinking":
      return <ThinkingBubble text={row.text} relMs={row.ts - t0} />;
    case "assistant":
      return <AssistantBubble text={row.text} relMs={row.ts - t0} />;
    case "tool":
      return <ToolCard row={row} relMs={row.ts - t0} />;
    case "usage":
      return (
        <StatusChip
          icon={<FileText size={11} />}
          text={`usage · ${row.tokensIn} in / ${row.tokensOut} out${row.costUsd !== undefined ? ` · ${formatUsd(row.costUsd)}` : ""}`}
          relMs={row.ts - t0}
          muted
        />
      );
    case "output-retry":
      return (
        <div className="px-4 py-2 text-xs border-l-2 border-amber-500/70 bg-amber-950/30 text-amber-200">
          <div className="flex items-center gap-2 mb-1 font-mono text-[10px] uppercase tracking-wider">
            <AlertCircle size={11} />
            <span>output retry #{row.attempt}</span>
            <span className="ml-auto">t+{((row.ts - t0) / 1000).toFixed(2)}s</span>
          </div>
          <div className="font-mono text-[11px] text-amber-100/80">{row.reason}</div>
        </div>
      );
    case "output-validated":
      return (
        <StatusChip
          icon={<FileText size={11} />}
          text="output validated against schema"
          relMs={row.ts - t0}
          muted
        />
      );
    case "subagent":
      return (
        <StatusChip
          icon={<Brain size={11} />}
          text={
            row.phase === "start"
              ? `subagent ${row.agentId ?? "?"} → ${row.childRunId}`
              : `subagent ${row.childRunId} ${row.status ?? "done"}`
          }
          relMs={row.ts - t0}
        />
      );
    case "memory-written":
      return (
        <StatusChip
          icon={<Brain size={11} />}
          text={`memory · ${row.scope}/${row.memKind} · ${row.summary.slice(0, 80)}`}
          relMs={row.ts - t0}
        />
      );
    case "memory-recalled":
      return (
        <StatusChip
          icon={<Brain size={11} />}
          text={`recall · ${row.query ? `"${row.query.slice(0, 40)}" · ` : ""}${row.hits.length} hit(s)`}
          relMs={row.ts - t0}
          muted
        />
      );
    case "run-end":
      return (
        <StatusChip
          icon={<Sparkles size={11} />}
          text={`run ended · ${row.status}`}
          relMs={row.ts - t0}
          tone={row.status === "success" ? "ok" : "warn"}
        />
      );
    case "error":
      return (
        <div className="px-4 py-2 border-l-2 border-red-500/70 bg-red-950/30 text-red-200">
          <div className="flex items-center gap-2 mb-1 text-[10px] uppercase tracking-wider font-mono">
            <AlertCircle size={11} />
            <span>{row.tag}</span>
            <span className="ml-auto">t+{((row.ts - t0) / 1000).toFixed(2)}s</span>
          </div>
          <div className="font-mono text-[11px] text-red-100/80">{row.message.slice(0, 600)}</div>
        </div>
      );
    default:
      return null;
  }
}

function StatusChip({
  icon,
  text,
  relMs,
  muted,
  tone,
}: {
  icon: React.ReactNode;
  text: string;
  relMs: number;
  muted?: boolean;
  tone?: "ok" | "warn";
}): React.ReactElement {
  return (
    <div
      className={cn(
        "px-3 py-1.5 text-[11px] font-mono flex items-center gap-2",
        muted ? "text-zinc-500" : "text-zinc-300",
        tone === "ok" && "text-emerald-400",
        tone === "warn" && "text-amber-400",
      )}
    >
      <span className={tone === "ok" ? "text-emerald-400" : tone === "warn" ? "text-amber-400" : "text-sky-400"}>
        {icon}
      </span>
      <span>{text}</span>
      <span className="ml-auto text-zinc-600">t+{(relMs / 1000).toFixed(2)}s</span>
    </div>
  );
}

function AssistantBubble({ text, relMs }: { text: string; relMs: number }): React.ReactElement {
  return (
    <div className="px-4 py-3 border-l-2 border-sky-500/40 bg-sky-950/10">
      <div className="flex items-center gap-2 mb-1.5 text-[10px] uppercase tracking-wider font-mono text-sky-400/80">
        <span>assistant</span>
        <span className="ml-auto text-zinc-600">t+{(relMs / 1000).toFixed(2)}s</span>
      </div>
      <div className="text-sm prose-agent text-zinc-200">
        <ReactMarkdown>{text}</ReactMarkdown>
      </div>
    </div>
  );
}

function ThinkingBubble({ text, relMs }: { text: string; relMs: number }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const preview = text.split("\n")[0]?.slice(0, 100) ?? "";
  return (
    <div className="px-4 py-2 bg-zinc-900/60">
      <button
        type="button"
        onClick={(): void => setOpen((v) => !v)}
        className="flex items-center gap-2 text-[10px] uppercase tracking-wider font-mono text-zinc-500 hover:text-zinc-300 w-full text-left"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Brain size={11} className="text-violet-400" />
        <span>thinking</span>
        {!open && (
          <span className="text-zinc-600 truncate normal-case tracking-normal italic font-sans ml-1 flex-1">
            {preview}…
          </span>
        )}
        <span className="text-zinc-600">t+{(relMs / 1000).toFixed(2)}s</span>
      </button>
      {open && (
        <div className="text-xs italic text-zinc-400 mt-2 whitespace-pre-wrap leading-relaxed">{text}</div>
      )}
    </div>
  );
}

function ToolCard({
  row,
  relMs,
}: {
  row: ParsedRow & { kind: "tool" };
  relMs: number;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const tone = row.result?.isError
    ? "border-red-500/60"
    : row.result
      ? "border-emerald-500/60"
      : "border-amber-500/60";

  return (
    <div className={cn("px-4 py-2 border-l-2", tone)}>
      <button
        type="button"
        onClick={(): void => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left text-xs"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Wrench size={12} className="text-sky-400" />
        <span className="font-mono font-semibold text-zinc-200">{row.toolName}</span>
        <span className="text-zinc-500 font-mono truncate flex-1">{summarizeInput(row.input)}</span>
        <span className="text-[10px] text-zinc-500 font-mono">
          {row.result ? (row.result.isError ? "error" : `${row.result.durationMs}ms`) : "running…"}
        </span>
        <span className="text-[10px] text-zinc-600 font-mono">t+{(relMs / 1000).toFixed(2)}s</span>
      </button>
      {open && (
        <div className="mt-2 ml-5 space-y-2">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono mb-1">input</div>
            <pre className="text-[11px] mono whitespace-pre-wrap bg-zinc-900 border border-zinc-800 p-2 rounded max-h-[300px] overflow-auto text-zinc-300">
              {JSON.stringify(row.input, null, 2)}
            </pre>
          </div>
          {row.result && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono mb-1">
                result{" "}
                {row.result.isError && <span className="text-red-400">(error)</span>}
              </div>
              <pre
                className={cn(
                  "text-[11px] mono whitespace-pre-wrap p-2 rounded max-h-[400px] overflow-auto border",
                  row.result.isError
                    ? "bg-red-950/30 border-red-900/60 text-red-100"
                    : "bg-zinc-900 border-zinc-800 text-zinc-300",
                )}
              >
                {row.result.content.slice(0, 6000)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const pick =
    obj.command ?? obj.file_path ?? obj.path ?? obj.url ?? obj.pattern ?? obj.query ?? obj.prompt ?? obj.agent_type;
  if (typeof pick === "string") return pick.slice(0, 140);
  return JSON.stringify(input).slice(0, 140);
}
