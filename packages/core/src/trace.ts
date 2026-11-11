/**
 * Trace format v1: the versioned, documented shape of a run's trace, for viewers and for
 * comparing runs across harness versions. A trace is a header plus the run's
 * `HarnessEvent`s in order; on disk it is JSON Lines (one header line, one line per event).
 *
 * Stability rules (also in `docs/reference/trace-format.mdx`):
 * - Adding an event kind or a field does NOT change the version. Readers MUST ignore unknown
 *   fields and MUST tolerate unknown kinds (`readEvent` returns them as `{ unknown: true }`).
 * - Removing or renaming a kind or field, or changing a field's type or meaning, bumps
 *   `TRACE_VERSION`.
 * - `REQUIRED_FIELDS` is exhaustive over `HarnessEvent["kind"]` at compile time: a new kind
 *   cannot be added without declaring what makes it well-formed.
 */
import type { HarnessEvent } from "./events.ts";

export const TRACE_VERSION = 1;

type Kind = HarnessEvent["kind"];
type FieldType = "string" | "number" | "boolean" | "object" | "array";

/** Fields every event carries, besides those below. */
const COMMON: Record<string, FieldType> = { runId: "string", ts: "number" };

/** Required fields per kind (beyond `kind`, `runId`, `ts`). Optional fields are not listed. */
export const REQUIRED_FIELDS: Readonly<Record<Kind, Readonly<Record<string, FieldType>>>> = {
  run_start: { agentId: "string", specHash: "string" },
  input_validated: {},
  turn_start: { turn: "number" },
  llm_call: { turn: "number", modelName: "string" },
  assistant_text: { turn: "number", text: "string" },
  thinking: { turn: "number", text: "string" },
  assistant_delta: { turn: "number", text: "string" },
  thinking_delta: { turn: "number", text: "string" },
  tool_call_start: { turn: "number", toolUseId: "string", toolName: "string" },
  tool_call_end: {
    turn: "number",
    toolUseId: "string",
    toolName: "string",
    result: "object",
    durationMs: "number",
  },
  usage: { turn: "number", usage: "object" },
  compaction: {
    turn: "number",
    trigger: "string",
    strategy: "string",
    beforeTokens: "number",
    afterTokens: "number",
    collapsedRange: "array",
    summarized: "boolean",
  },
  subagent_start: { childRunId: "string", agentId: "string" },
  subagent_end: { childRunId: "string", status: "string" },
  output_validated: {},
  output_retry: { attempt: "number", reason: "string" },
  run_end: { status: "string" },
  memory_written: { entry: "object" },
  memory_recalled: { scopes: "array", hits: "array" },
  prompt_rendered: {
    cacheablePrefixChars: "number",
    totalChars: "number",
    reordered: "boolean",
    warnings: "array",
  },
  error: { tag: "string", message: "string" },
};

export const KNOWN_EVENT_KINDS: ReadonlyArray<Kind> = Object.keys(REQUIRED_FIELDS) as Kind[];

/** A kind this reader does not know, or a known kind missing a required field: kept, never dropped. */
export interface UnknownTraceEvent {
  unknown: true;
  kind: string;
  /** Why it is not a typed event: `unknown_kind`, or `malformed: <field>`. */
  reason: string;
  /** The event as stored. */
  raw: Record<string, unknown>;
}

export type TraceEvent = HarnessEvent | UnknownTraceEvent;

const typeOf = (v: unknown): FieldType | "other" =>
  Array.isArray(v)
    ? "array"
    : v === null
      ? "other"
      : typeof v === "object"
        ? "object"
        : typeof v === "string" || typeof v === "number" || typeof v === "boolean"
          ? (typeof v as FieldType)
          : "other";

/** Read one stored event. Never throws; non-objects come back as `unknown_kind` with `kind: ""`. */
export function readEvent(value: unknown): TraceEvent {
  const raw = (
    value !== null && typeof value === "object" && !Array.isArray(value) ? value : { value }
  ) as Record<string, unknown>;
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  // Own keys only: a kind of `__proto__` / `constructor` must not find Object.prototype members.
  const spec = Object.hasOwn(REQUIRED_FIELDS, kind) ? REQUIRED_FIELDS[kind as Kind] : undefined;
  if (!spec) return { unknown: true, kind, reason: "unknown_kind", raw };
  for (const [field, type] of Object.entries({ ...COMMON, ...spec })) {
    if (typeOf(raw[field]) !== type)
      return { unknown: true, kind, reason: `malformed: ${field}`, raw };
  }
  return raw as unknown as HarnessEvent;
}

/** Header line of a stored trace. */
export interface TraceHeader {
  traceVersion: number;
  runId: string;
  agentId?: string;
  specHash?: string;
  /** Version of the harness that wrote the trace, for comparing runs across versions. */
  harnessVersion?: string;
  startedAt?: number;
}

export interface Trace {
  header: TraceHeader;
  events: ReadonlyArray<TraceEvent>;
}

/** Serialise: line 1 is `{"kind":"trace_header",...}`, then one event per line. */
export function traceToJsonl(trace: Trace): string {
  const lines = [JSON.stringify({ kind: "trace_header", ...trace.header })];
  for (const e of trace.events) lines.push(JSON.stringify("unknown" in e && e.unknown ? e.raw : e));
  return `${lines.join("\n")}\n`;
}

export interface ParsedTrace extends Trace {
  /** Lines that were not JSON, and why a header was missing. The trace is still returned. */
  warnings: ReadonlyArray<string>;
}

/**
 * Parse JSONL tolerantly: a missing header gets `traceVersion: 0` and a warning; an unreadable
 * line is skipped with a warning; unknown kinds are kept as {@link UnknownTraceEvent}. A trace
 * written by a NEWER format version is still read (fields are only ever added) and flagged.
 */
export function parseTraceJsonl(text: string): ParsedTrace {
  const warnings: string[] = [];
  let header: TraceHeader | undefined;
  const events: TraceEvent[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      warnings.push(`line ${i + 1}: not JSON`);
      return;
    }
    const o = v as Record<string, unknown> | null;
    if (o && o.kind === "trace_header" && !header) {
      const { kind: _k, ...rest } = o;
      header = rest as unknown as TraceHeader;
      return;
    }
    events.push(readEvent(v));
  });
  if (!header) {
    warnings.push("no trace_header line");
    header = {
      traceVersion: 0,
      runId: (events.find((e) => !("unknown" in e)) as HarnessEvent | undefined)?.runId ?? "",
    };
  } else if (header.traceVersion > TRACE_VERSION) {
    warnings.push(
      `trace version ${header.traceVersion} is newer than this reader (${TRACE_VERSION}); unknown fields ignored`,
    );
  }
  return { header, events, warnings };
}

/** Per-name counters. Null-prototype objects: names come from the trace and may be `__proto__`. */
export interface NameStats {
  count: number;
  errors: number;
  totalMs: number;
}
export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Comparable numbers from a trace: what an admin viewer lists and what a version-to-version diff compares.
 * Every record keyed by a name that came out of the trace (`byTool`, `usageByProvider`, `unknownKinds`) is a
 * null-prototype object, so `__proto__`, `constructor` and `prototype` are ordinary keys.
 */
export interface TraceSummary {
  status: string | null;
  turns: number;
  toolCalls: { count: number; errors: number; totalMs: number; byTool: Record<string, NameStats> };
  usage: UsageStats;
  /** Usage by serving provider, when `usage` events name one. */
  usageByProvider: Record<string, UsageStats>;
  compactions: number;
  subagents: number;
  errors: number;
  /** Events this reader could not type. */
  unknownEvents: number;
  /** Counts of kinds it does not know, by kind (failovers, budget warnings, ... until they are in the table). */
  unknownKinds: Record<string, number>;
}

/** A null-prototype record built from a Map: the only place accumulators become objects. */
function toRecord<V>(m: ReadonlyMap<string, V>): Record<string, V> {
  const out = Object.create(null) as Record<string, V>;
  for (const [k, v] of m)
    Object.defineProperty(out, k, {
      value: v,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return out;
}

export function summarizeTrace(events: ReadonlyArray<TraceEvent>): TraceSummary {
  const total = { count: 0, errors: 0, totalMs: 0 };
  const byTool = new Map<string, NameStats>();
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const byProvider = new Map<string, UsageStats>();
  const unknownKinds = new Map<string, number>();
  let status: string | null = null;
  let turns = 0;
  let compactions = 0;
  let subagents = 0;
  let errors = 0;
  let unknownEvents = 0;
  for (const e of events) {
    if ("unknown" in e) {
      unknownEvents++;
      if (e.reason === "unknown_kind")
        unknownKinds.set(e.kind, (unknownKinds.get(e.kind) ?? 0) + 1);
      continue;
    }
    switch (e.kind) {
      case "turn_start":
        turns = Math.max(turns, e.turn);
        break;
      case "tool_call_end": {
        let t = byTool.get(e.toolName);
        if (!t) byTool.set(e.toolName, (t = { count: 0, errors: 0, totalMs: 0 }));
        const failed = e.result.isError === true;
        for (const x of [total, t]) {
          x.count++;
          x.totalMs += e.durationMs;
          if (failed) x.errors++;
        }
        break;
      }
      case "usage": {
        usage.inputTokens += e.usage.inputTokens;
        usage.outputTokens += e.usage.outputTokens;
        usage.costUsd += e.usage.costUsd ?? 0;
        const provider = (e as { provider?: unknown }).provider;
        if (typeof provider === "string") {
          let p = byProvider.get(provider);
          if (!p) byProvider.set(provider, (p = { inputTokens: 0, outputTokens: 0, costUsd: 0 }));
          p.inputTokens += e.usage.inputTokens;
          p.outputTokens += e.usage.outputTokens;
          p.costUsd += e.usage.costUsd ?? 0;
        }
        break;
      }
      case "compaction":
        compactions++;
        break;
      case "subagent_start":
        subagents++;
        break;
      case "error":
        errors++;
        break;
      case "run_end":
        status = e.status;
        break;
      default:
        break;
    }
  }
  return {
    status,
    turns,
    toolCalls: { ...total, byTool: toRecord(byTool) },
    usage,
    usageByProvider: toRecord(byProvider),
    compactions,
    subagents,
    errors,
    unknownEvents,
    unknownKinds: toRecord(unknownKinds),
  };
}
