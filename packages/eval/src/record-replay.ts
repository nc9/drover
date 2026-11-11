/**
 * Record / replay of provider responses, through the `HarnessDeps.streamFn`
 * seam. Record a run once against the real provider, then replay it offline:
 * same events, same output, no network, no cost — for evals and CI.
 *
 *   const rec = createRecorder();
 *   await runAgent(spec, input, { streamFn: recordStream(realStreamFn, rec.sink) }).result;
 *   await Bun.write("run.json", JSON.stringify(rec.recording()));
 *   // later, offline:
 *   await runAgent(spec, input, { streamFn: replayStream(JSON.parse(text)) }).result;
 *
 * Turns are keyed by call index (the Nth model call of the run). Each turn also
 * stores a hash of the request (system prompt, messages, tool names; volatile
 * `timestamp` fields excluded). Replay compares it, so a changed prompt or tool
 * result fails loudly instead of silently replaying a stale answer.
 *
 * WARNING: a recording holds the full model RESPONSES (and its hash is derived
 * from the full prompt). If the run touched private data (customer content,
 * fetched pages, secrets in tool output), the recording contains it. Do not
 * commit such recordings; scrub with `recordStream`'s `redact` option or record
 * against synthetic data only.
 *
 * Call-index keying assumes model calls happen in a deterministic order: a run
 * with parallel subagents, whose calls interleave, is not replayable.
 */
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

export const RECORDING_VERSION = 1;

/** One model call: the request fingerprint and the full event stream it produced. */
export interface RecordedTurn {
  /** Zero-based index of the model call within the run. */
  index: number;
  /** Fingerprint of the request; see {@link hashRequest}. */
  requestHash: string;
  /** Model id the call was made against (informational, not compared). */
  modelId: string;
  /** Every event, in order, ending with `done` or `error`. */
  events: AssistantMessageEvent[];
}

/** JSON-serialisable recording of a whole run. */
export interface StreamRecording {
  version: typeof RECORDING_VERSION;
  turns: RecordedTurn[];
}

export type RecordingSink = (turn: RecordedTurn) => void | Promise<void>;

type StreamArgs = Parameters<StreamFn>;

/** Thrown (inside the model call) when a replayed request differs from the recorded one. */
export class ReplayDriftError extends Error {
  readonly _tag = "ReplayDriftError";
  constructor(
    readonly turnIndex: number,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `replay drift at turn ${turnIndex}: request hash ${actual} != recorded ${expected} ` +
        `(prompt, history or tools changed since the recording)`,
    );
  }
}

/** Thrown when replay is asked for more model calls than were recorded. */
export class ReplayExhaustedError extends Error {
  readonly _tag = "ReplayExhaustedError";
  constructor(
    readonly turnIndex: number,
    readonly recorded: number,
  ) {
    super(`replay exhausted: model call ${turnIndex} requested but only ${recorded} recorded`);
  }
}

/** Canonical JSON: sorted keys, `timestamp` dropped (it differs on every run). */
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => k !== "timestamp" && o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
};

/** cyrb53: small, sync, runtime-agnostic (no node:crypto, fine in Workers). */
const hashString = (s: string): string => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
};

/** Fingerprint of a model request: system prompt, messages and tool names. */
export const hashRequest = (context: StreamArgs[1]): string =>
  hashString(
    canonical({
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      tools: (context.tools ?? []).map((t) => t.name),
    }),
  );

const isTerminal = (e: AssistantMessageEvent): boolean => e.type === "done" || e.type === "error";

const syntheticError = (model: StreamArgs[0], err: unknown): AssistantMessageEvent => ({
  type: "error",
  reason: "error",
  error: {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: err instanceof Error ? err.message : String(err),
    timestamp: Date.now(),
  } satisfies AssistantMessage,
});

export interface RecordOptions {
  /**
   * Scrub a turn before it reaches the sink (the live run still sees the
   * original events). Receives a deep copy; return the turn to store. Keep
   * `index` and `requestHash`. A redacted recording replays redacted text, so
   * outputs that depend on the original will differ; use it for recordings
   * you intend to share, and replay them with `onDrift` as needed.
   */
  redact?: (turn: RecordedTurn) => RecordedTurn;
}

/**
 * Wrap a real `streamFn`: events pass through untouched while each completed
 * call is handed to `sink` (before its terminal event is delivered, so the
 * recording is complete by the time the run ends). Each wrapper instance
 * numbers its own calls from 0 — make one per run.
 */
export const recordStream = (
  real: StreamFn,
  sink: RecordingSink,
  recordOptions: RecordOptions = {},
): StreamFn => {
  let next = 0;
  return (model, context, options) => {
    const index = next++;
    const requestHash = hashRequest(context);
    const out = createAssistantMessageEventStream();
    void (async () => {
      const events: AssistantMessageEvent[] = [];
      let finished = false;
      const deliver = async (e: AssistantMessageEvent): Promise<void> => {
        events.push(e);
        if (isTerminal(e)) {
          finished = true;
          const turn: RecordedTurn = { index, requestHash, modelId: model.id, events };
          // `events` is also what the live run consumes: hand redact a copy.
          await sink(recordOptions.redact ? recordOptions.redact(structuredClone(turn)) : turn);
        }
        out.push(e);
      };
      try {
        const src = await real(model, context, options);
        for await (const e of src) {
          await deliver(e);
          if (finished) break;
        }
      } catch (err) {
        if (!finished) await deliver(syntheticError(model, err));
      }
      if (!finished) await deliver(syntheticError(model, "stream ended without a terminal event"));
      out.end();
    })();
    return out;
  };
};

/** Collects turns in memory. `sink` plugs into {@link recordStream}. */
export const createRecorder = (): {
  sink: RecordingSink;
  recording: () => StreamRecording;
} => {
  const turns: RecordedTurn[] = [];
  return {
    sink: (t) => {
      turns.push(t);
    },
    recording: () => ({
      version: RECORDING_VERSION,
      turns: [...turns].sort((a, b) => a.index - b.index),
    }),
  };
};

export interface ReplayOptions {
  /**
   * What to do when the request hash differs from the recorded one.
   * `"throw"` (default) fails the model call with {@link ReplayDriftError};
   * `"ignore"` replays anyway; a function is called with the error and
   * decides by returning normally (replay proceeds) or throwing.
   */
  onDrift?: "throw" | "ignore" | ((err: ReplayDriftError) => void);
}

/**
 * A `streamFn` that serves a recording: the Nth call returns the Nth recorded
 * turn's events. No network. Throws {@link ReplayExhaustedError} when the run
 * makes more calls than were recorded. Make one per run (it counts calls).
 */
export const replayStream = (recording: StreamRecording, options: ReplayOptions = {}): StreamFn => {
  if (recording.version !== RECORDING_VERSION) {
    throw new Error(`unsupported recording version ${String(recording.version)}`);
  }
  const byIndex = new Map(recording.turns.map((t) => [t.index, t]));
  const onDrift = options.onDrift ?? "throw";
  let next = 0;
  return (_model, context) => {
    const index = next++;
    const turn = byIndex.get(index);
    if (!turn) throw new ReplayExhaustedError(index, recording.turns.length);
    const actual = hashRequest(context);
    if (actual !== turn.requestHash && onDrift !== "ignore") {
      const err = new ReplayDriftError(index, turn.requestHash, actual);
      if (onDrift === "throw") throw err;
      onDrift(err);
    }
    const out = createAssistantMessageEventStream();
    // structuredClone: replays must not share (and mutate) the recording's objects.
    for (const e of structuredClone(turn.events)) out.push(e);
    out.end();
    return out;
  };
};
