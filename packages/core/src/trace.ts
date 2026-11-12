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
  // `to` and `status` are nullable, so not listed; `code` is optional (allow-listed when present).
  provider_failover: { action: "string", from: "string", failureClass: "string" },
  budget_warning: { dimension: "string", limit: "number", used: "number" },
  chain_record: { providers: "array" },
  warning: { code: "string", message: "string", count: "number" },
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

/**
 * Fields that can hold text from outside the harness: model output, tool output or arguments,
 * error text, memory content, a recall query. A consumer MUST treat them as untrusted data:
 * HTML-escape before rendering, and never feed them back to a model as instructions.
 * `summarizeTrace` never reads them. A path is a top-level field or `field.key` (one level into an
 * object), so structural flags next to the text (`result.isError`, `entry.id`) stay readable.
 *
 * Also outside text, but not marked (the reader and summary key on them) and not redactable:
 * `toolName` (model-chosen, or from an MCP server), the summary's `byTool` / `usageByProvider` keys,
 * and a usage event's `provider` / `model`. Escape them when rendering.
 *
 * `provider_failover` is not marked: it carries no provider text. `from` / `to` are the chain's
 * configured provider names, `failureClass` and `status` are the classifier's, and `code` is set
 * only from an allow-list of known provider error codes.
 */
export const UNTRUSTED_FIELDS: Readonly<Partial<Record<Kind, ReadonlyArray<string>>>> = {
  assistant_text: ["text"],
  thinking: ["text"],
  assistant_delta: ["text"],
  thinking_delta: ["text"],
  tool_call_start: ["input"],
  tool_call_end: ["result.content", "result.data"],
  output_retry: ["reason"],
  memory_written: ["entry.summary"],
  memory_recalled: ["query"],
  error: ["message"],
  prompt_rendered: ["warnings"],
};

/** What a redaction hook does to a marked field. */
export type Redaction = "remove" | "mask";

/**
 * Hook for {@link redactEvent} / {@link traceToJsonl}: called once per marked field present on
 * the event (`field` is the path, e.g. `result.content`); return `"remove"` to drop it, `"mask"`
 * to replace it with {@link REDACTED}, or `undefined` to keep it.
 */
export type RedactHook = (info: {
  kind: string;
  field: string;
  value: unknown;
}) => Redaction | undefined;

export const REDACTED = "[redacted]";

const markedFields = (kind: string): ReadonlyArray<string> =>
  (Object.hasOwn(UNTRUSTED_FIELDS, kind) ? UNTRUSTED_FIELDS[kind as Kind] : undefined) ?? [];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// Redact the marked paths of `kind` on a plain event object. Returns a copy.
function redactFields(
  e: Record<string, unknown>,
  kind: string,
  hook: RedactHook,
): Record<string, unknown> {
  const out = { ...e };
  for (const path of markedFields(kind)) {
    const [head = "", key] = path.split(".");
    // One level deep: copy the parent object so the input event is never mutated.
    const parent =
      key === undefined ? out : isPlainObject(out[head]) ? { ...out[head] } : undefined;
    const field = key ?? head;
    if (!parent || !Object.hasOwn(parent, field)) continue;
    const action = hook({ kind, field: path, value: parent[field] });
    if (action === "remove") delete parent[field];
    else if (action === "mask") parent[field] = REDACTED;
    if (key !== undefined) out[head] = parent;
  }
  return out;
}

/**
 * Apply a redaction hook to the marked fields of one event. Returns a copy; the input is
 * untouched. A malformed event of a KNOWN kind is redacted by that kind's marked paths (on its
 * stored `raw`); only events of an unknown kind pass through unredacted.
 */
export function redactEvent(e: TraceEvent, hook: RedactHook): TraceEvent {
  if ("unknown" in e) {
    if (!Object.hasOwn(REQUIRED_FIELDS, e.kind)) return e;
    return { ...e, raw: redactFields(e.raw, e.kind, hook) };
  }
  return redactFields(
    e as unknown as Record<string, unknown>,
    e.kind,
    hook,
  ) as unknown as TraceEvent;
}

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
  // A redacted top-level marked field (masked to "[redacted]" or removed, see `redactEvent`)
  // still reads as typed. Only marked fields: "[redacted]" or a gap in `durationMs`, `turn` or
  // `usage` is malformed, not redacted.
  const marked = new Set(markedFields(kind).filter((f) => !f.includes(".")));
  for (const [field, type] of Object.entries({ ...COMMON, ...spec })) {
    if (marked.has(field) && (raw[field] === REDACTED || !Object.hasOwn(raw, field))) continue;
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

/**
 * JSON.stringify, then escape characters that break when a line is embedded in HTML or a script
 * (`<`, `>`, `&`) or read by JavaScript line parsers (U+2028, U+2029). The result is still valid
 * JSON that parses to the same value.
 */
export function safeStringify(v: unknown): string {
  return JSON.stringify(v).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Serialise: line 1 is `{"kind":"trace_header",...}`, then one event per line. Lines are escaped
 * with {@link safeStringify}. Pass `redact` to remove or mask the {@link UNTRUSTED_FIELDS} on export
 * (malformed events of a known kind included). Events of an unknown kind are written as stored
 * (their fields are not known to be marked), so redact them yourself if the trace may hold kinds
 * this version does not know.
 */
export function traceToJsonl(trace: Trace, options?: { redact?: RedactHook }): string {
  const lines = [safeStringify({ kind: "trace_header", ...trace.header })];
  for (const e of trace.events) {
    const out = options?.redact ? redactEvent(e, options.redact) : e;
    lines.push(safeStringify("unknown" in out && out.unknown ? out.raw : out));
  }
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
  toolCalls: {
    count: number;
    errors: number;
    totalMs: number;
    byTool: Record<string, NameStats>;
    /**
     * Calls refused because the same call had already failed in the run (`result.denied.code ===
     * "repeat_refusal"`, from `repeatRefusalPlugin`). Each is also in `errors`.
     */
    repeatedFailures: number;
  };
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
  let repeatedFailures = 0;
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
        if (e.result.denied?.code === "repeat_refusal") repeatedFailures++;
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
    toolCalls: { ...total, byTool: toRecord(byTool), repeatedFailures },
    usage,
    usageByProvider: toRecord(byProvider),
    compactions,
    subagents,
    errors,
    unknownEvents,
    unknownKinds: toRecord(unknownKinds),
  };
}
