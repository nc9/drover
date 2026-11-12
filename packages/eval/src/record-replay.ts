/**
 * Record / replay of provider responses, through the `HarnessDeps.streamFn`
 * seam. Record a run once against the real provider, then replay it offline:
 * same events, same output, no network, no cost — for evals and CI.
 *
 *   const rec = createRecorder();
 *   await runAgentEffect({ ...args, deps: { ...deps, streamFn: recordStream(real, rec.sink) } });
 *   await Bun.write("run.json", JSON.stringify(rec.recording()));
 *   // later, offline:
 *   await runAgentEffect({ ...args, deps: { ...deps, streamFn: replayStream(JSON.parse(text)) } });
 *
 * Turns are keyed by conversation, not global order: `thread` is a hash of the
 * system prompt and the first message (one per agent run, so each subagent has
 * its own), and `threadIndex` counts calls within it. Each turn also stores a
 * hash of the whole request (system prompt, messages, tool names; volatile
 * `timestamp` fields excluded). Replay serves, within the call's thread, the
 * first unused turn whose request hash matches, so interleaved calls of
 * parallel subagents replay correctly (but see `ReplayAmbiguousError` for two
 * subagents with an identical system prompt AND first message running at the
 * same time). A request that matches nothing fails
 * loudly (`ReplayDriftError`, naming the call) instead of replaying a stale
 * answer. The hashes are a 53-bit change detector, not an integrity check: do
 * not use them to authenticate a recording.
 *
 * WARNING: a recording holds the full model RESPONSES (and its hash is derived
 * from the full prompt). If the run touched private data (customer content,
 * fetched pages, secrets in tool output), the recording contains it. Do not
 * commit such recordings; scrub with `recordStream`'s `redact` option or record
 * against synthetic data only. API keys and request headers are never recorded
 * (only the request hash and the response events are), and a failed call's raw
 * provider text is replaced by its status-only form unless `keepProviderText`.
 */
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/**
 * Recording format version.
 *
 * 2: the request key reads the transcript's system messages (pi 1.x carries the system
 * prompt and tool declarations there, not in `Context.systemPrompt` / `Context.tools`).
 * A version 1 recording was keyed on the old fields and cannot match any request, so
 * `replayStream` rejects it with a re-record error.
 */
export const RECORDING_VERSION = 2;

/** One model call: the request fingerprint and the full event stream it produced. */
export interface RecordedTurn {
  /** Zero-based index of the model call within the recording (completion order is not guaranteed). */
  index: number;
  /** Conversation key: hash of the system prompt and first message. One per agent run. */
  thread: string;
  /** Zero-based index of the call within its thread. */
  threadIndex: number;
  /** Fingerprint of the request; see {@link hashRequest}. */
  requestHash: string;
  /** Model id the call was made against (informational, not compared). */
  modelId: string;
  /** Every event, in order, ending with `done` or `error`. */
  events: AssistantMessageEvent[];
  /**
   * Another call on the same thread was in flight when this one started: two
   * concurrent runs share the thread (identical system prompt and first message).
   */
  concurrent?: true;
}

/** JSON-serialisable recording of a whole run. */
export interface StreamRecording {
  version: typeof RECORDING_VERSION;
  turns: RecordedTurn[];
}

export type RecordingSink = (turn: RecordedTurn) => void | Promise<void>;

type StreamArgs = Parameters<StreamFn>;

/** Thrown (inside the model call) when a replayed request matches no recorded turn. */
export class ReplayDriftError extends Error {
  readonly _tag = "ReplayDriftError";
  constructor(
    /** Recording index of the turn this call was compared with (the thread's next unused turn), or -1 for an unknown thread. */
    readonly turnIndex: number,
    readonly expected: string,
    readonly actual: string,
    readonly thread: string,
    readonly threadIndex: number,
  ) {
    super(
      turnIndex < 0
        ? `replay drift at call ${threadIndex} of thread ${thread}: no recorded conversation ` +
            `starts with this system prompt and first message`
        : `replay drift at call ${threadIndex} of thread ${thread} (recorded turn ${turnIndex}): ` +
            `request hash ${actual} != recorded ${expected} ` +
            `(prompt, history or tools changed since the recording)`,
    );
  }
}

/**
 * Thrown when a call cannot be told apart from another recorded call: two
 * subagents with an identical system prompt and first message ran at the same
 * time (they share a thread), and at least two unused recorded turns of that
 * thread have the same request but different answers. Serving either could
 * hand one subagent the other's answer. Give each concurrent subagent a
 * distinguishing first message (e.g. its task id) and record again.
 */
export class ReplayAmbiguousError extends Error {
  readonly _tag = "ReplayAmbiguousError";
  constructor(
    readonly thread: string,
    readonly threadIndex: number,
    readonly candidates: number,
  ) {
    super(
      `replay ambiguous at call ${threadIndex} of thread ${thread}: ${candidates} recorded calls ` +
        `have this exact request but different answers, from concurrent subagents with an ` +
        `identical system prompt and first message; give each a distinguishing first message`,
    );
  }
}

/** A recording-side failure (a `sink` or `redact` that threw), reported to `onError`. */
export interface RecordError {
  error: unknown;
  /** The turn being recorded. */
  index: number;
  thread: string;
  threadIndex: number;
}

/** Thrown when a thread asks for more model calls than were recorded for it. */
export class ReplayExhaustedError extends Error {
  readonly _tag = "ReplayExhaustedError";
  constructor(
    readonly thread: string,
    readonly threadIndex: number,
    readonly recorded: number,
  ) {
    super(
      `replay exhausted: call ${threadIndex} of thread ${thread} requested but only ${recorded} recorded`,
    );
  }
}

/**
 * Canonical JSON: sorted keys, wall-clock fields dropped. `timestamp` differs on every run;
 * pi 1.x also stamps `durationMs` (measured tool and call time) on tool results and replies.
 */
const canonical = (v: unknown, omit: ReadonlySet<string> = TIMESTAMP_ONLY): string => {
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x, omit)).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => !omit.has(k) && o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k], omit)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
};
const TIMESTAMP_ONLY: ReadonlySet<string> = new Set(["timestamp", "durationMs"]);
/** Fields that differ between two otherwise identical answers (a provider's per-response id, clocks). */
const VOLATILE_ANSWER_FIELDS: ReadonlySet<string> = new Set(["timestamp", "durationMs", "responseId"]);
/** An answer's identity for the ambiguity check: its events, without volatile fields, key order ignored. */
const answerKey = (t: RecordedTurn): string => canonical(t.events, VOLATILE_ANSWER_FIELDS);

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

/**
 * What a request is keyed on, read from the transcript: the current system prompt and tool
 * names (every system message replayed), and the conversation without its system messages.
 */
const requestParts = (context: StreamArgs[1]) => ({
  systemPrompt: getCurrentSystemPrompt(context.messages),
  tools: getCurrentTools(context.messages).map((t) => t.name),
  messages: context.messages.filter((m) => m.role !== "system"),
});

/** Fingerprint of a model request: system prompt, messages and tool names. */
export const hashRequest = (context: StreamArgs[1]): string =>
  hashString(canonical(requestParts(context)));

/** Conversation key: the system prompt and the first message identify one agent run. */
export const threadKey = (context: StreamArgs[1]): string => {
  const { systemPrompt, messages } = requestParts(context);
  return hashString(canonical({ systemPrompt, first: messages[0] ?? null }));
};

/** `<status> ...` -> `provider error <status>`; anything else -> `provider error`. Same rule as the harness. */
const statusOnly = (text: string | undefined): string => {
  const code = /^([45]\d\d)\b/.exec(text?.trim() ?? "")?.[1];
  return code ? `provider error ${code}` : "provider error";
};

/** Error events with the raw provider text replaced (it can quote the prompt). */
const scrubProviderText = (events: AssistantMessageEvent[]): AssistantMessageEvent[] =>
  events.map((e) =>
    e.type === "error" && typeof e.error.errorMessage === "string"
      ? {
          ...e,
          error: {
            ...e.error,
            errorMessage: e.reason === "aborted" ? "aborted" : statusOnly(e.error.errorMessage),
          },
        }
      : e,
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
   * `index`, `thread`, `threadIndex` and `requestHash` unchanged: replay
   * matches on them. A redacted recording replays redacted text, so
   * outputs that depend on the original will differ; use it for recordings
   * you intend to share, and replay them with `onDrift` as needed.
   */
  redact?: (turn: RecordedTurn) => RecordedTurn;
  /**
   * Keep a failed call's raw provider text (`errorMessage`) in the recording.
   * Off by default: it can quote the prompt. The live run is unaffected either way.
   */
  keepProviderText?: boolean;
  /**
   * Called when `sink` or `redact` throws or rejects. The live run is never
   * affected: the call's terminal event is always delivered, so a broken sink
   * cannot hang or fail the run; that turn is simply missing from the
   * recording. Default: the error is kept on the returned function's
   * `errors` list; check it after the run (a recording with errors is
   * incomplete).
   */
  onError?: (e: RecordError) => void;
}

/** The `streamFn` `recordStream` returns, with the recording-side failures so far. */
export type RecordingStreamFn = StreamFn & { readonly errors: ReadonlyArray<RecordError> };

/**
 * Wrap a real `streamFn`: events pass through untouched while each completed
 * call is handed to `sink` (before its terminal event is delivered, so the
 * recording is complete by the time the run ends). Each wrapper instance
 * numbers its own calls from 0 — make one per run (subagents share it).
 */
export const recordStream = (
  real: StreamFn,
  sink: RecordingSink,
  recordOptions: RecordOptions = {},
): RecordingStreamFn => {
  let next = 0;
  const perThread = new Map<string, number>();
  const inFlight = new Map<string, number>();
  const errors: RecordError[] = [];
  const report = (e: RecordError): void => {
    if (recordOptions.onError) {
      try {
        recordOptions.onError(e);
      } catch {
        /* an error handler must not break the run either */
      }
    } else errors.push(e);
  };
  const fn: StreamFn = (model, context, options) => {
    const index = next++;
    const thread = threadKey(context);
    const threadIndex = perThread.get(thread) ?? 0;
    perThread.set(thread, threadIndex + 1);
    const requestHash = hashRequest(context);
    // Counted in flight only once the hashes are done: a throw above leaves no
    // phantom in-flight call that would mark a later, sequential call concurrent.
    const concurrent = (inFlight.get(thread) ?? 0) > 0;
    inFlight.set(thread, (inFlight.get(thread) ?? 0) + 1);
    const out = createAssistantMessageEventStream();
    void (async () => {
      const events: AssistantMessageEvent[] = [];
      let finished = false;
      const deliver = async (e: AssistantMessageEvent): Promise<void> => {
        events.push(e);
        if (isTerminal(e)) {
          finished = true;
          // `events` is also what the live run consumes: the sink gets a copy.
          // The terminal event is pushed whatever the sink or redact does:
          // a throwing or rejecting sink must not hang or fail the live run.
          try {
            const stored: RecordedTurn = {
              index,
              thread,
              threadIndex,
              requestHash,
              modelId: model.id,
              events: recordOptions.keepProviderText
                ? structuredClone(events)
                : scrubProviderText(structuredClone(events)),
              ...(concurrent ? { concurrent: true as const } : {}),
            };
            await sink(recordOptions.redact ? recordOptions.redact(stored) : stored);
          } catch (error) {
            report({ error, index, thread, threadIndex });
          } finally {
            // No longer in flight from here: a call that starts after this one
            // finished is sequential, not concurrent.
            inFlight.set(thread, (inFlight.get(thread) ?? 1) - 1);
            out.push(e);
          }
          return;
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
  return Object.assign(fn, { errors });
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
 * A `streamFn` that serves a recording. A call is matched within its thread
 * (system prompt + first message): the first unused turn of that thread whose
 * request hash matches is replayed, so call order across parallel subagents
 * does not matter. No match: {@link ReplayDriftError} naming the call (with
 * `onDrift` relaxing it, the thread's next unused turn is replayed). A thread
 * asking for more calls than recorded: {@link ReplayExhaustedError}. No network.
 * Make one per run (it tracks used turns).
 */
export const replayStream = (recording: StreamRecording, options: ReplayOptions = {}): StreamFn => {
  if (recording.version !== RECORDING_VERSION) {
    throw new Error(
      `unsupported recording version ${String(recording.version)} (this build reads ${RECORDING_VERSION}): ` +
        `re-record it. Version 1 recordings were keyed on the pre-pi-1.x request shape (system prompt as a ` +
        `context field) and cannot match a request made now.`,
    );
  }
  const threads = new Map<string, RecordedTurn[]>();
  for (const t of [...recording.turns].sort((a, b) => a.threadIndex - b.threadIndex)) {
    const list = threads.get(t.thread) ?? [];
    list.push(t);
    threads.set(t.thread, list);
  }
  const used = new Set<RecordedTurn>();
  const calls = new Map<string, number>();
  const onDrift = options.onDrift ?? "throw";
  return (_model, context) => {
    const thread = threadKey(context);
    const threadIndex = calls.get(thread) ?? 0;
    calls.set(thread, threadIndex + 1);
    const actual = hashRequest(context);
    const list = threads.get(thread) ?? [];
    const unused = list.filter((t) => !used.has(t));
    const matching = unused.filter((t) => t.requestHash === actual);
    // Concurrent runs on one thread with the same request but different answers
    // cannot be told apart: refuse rather than hand one the other's answer.
    if (
      matching.length > 1 &&
      matching.some((t) => t.concurrent) &&
      new Set(matching.map(answerKey)).size > 1
    )
      throw new ReplayAmbiguousError(thread, threadIndex, matching.length);
    let turn = matching[0];
    if (!turn) {
      const anyUnused = recording.turns.some((t) => !used.has(t));
      if ((list.length > 0 && unused.length === 0) || !anyUnused)
        throw new ReplayExhaustedError(thread, threadIndex, list.length);
      // An unknown thread (changed system prompt or first message) can only be
      // replayed in relaxed mode, by recording order.
      const nextTurn =
        unused[0] ??
        [...recording.turns].sort((a, b) => a.index - b.index).find((t) => !used.has(t));
      if (onDrift !== "ignore" || !nextTurn) {
        const err = new ReplayDriftError(
          list.length > 0 ? (nextTurn?.index ?? -1) : -1,
          nextTurn?.requestHash ?? "",
          actual,
          thread,
          threadIndex,
        );
        if (onDrift === "throw" || !nextTurn) throw err;
        if (onDrift !== "ignore") onDrift(err);
      }
      turn = nextTurn;
    }
    used.add(turn);
    const out = createAssistantMessageEventStream();
    // structuredClone: replays must not share (and mutate) the recording's objects.
    for (const e of structuredClone(turn.events)) out.push(e);
    out.end();
    return out;
  };
};
