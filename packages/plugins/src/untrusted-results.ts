/**
 * INVARIANT: anything that did not come from the operator's own prompt or code is
 * untrusted until positively marked trusted; derived text inherits the least
 * trusted input. Fail closed: every bookkeeping miss over-fences, none under-fences.
 *
 * What that means here:
 * - EVERY tool result is fenced (success, error and defect alike), unless the tool
 *   is on the one `trusted` allowlist this plugin owns. Output is never inspected
 *   to decide: a result that contains a fence-shaped string is wrapped like any
 *   other. The only other opt-out is the explicit `selfFenced` list (and even
 *   there errors are wrapped).
 * - A reader tool (a stored copy by handle: the truncate plugin's
 *   `show_tool_result`) returns provenance in its own result `data` (`trusted`,
 *   `toolId`), from the same read as the content. It is returned raw only when
 *   that says trusted AND the producing tool is on this plugin's allowlist
 *   (a tool on "both sides" of two lists would be untrusted). Anything else,
 *   including a missing flag, is fenced.
 * - Derived text is fenced too: the plugin implements `wrapUntrusted`, which the
 *   harness uses for the compaction summary and the untrusted entries of the
 *   memory index; and `systemPromptAddendum`, which carries the fence note, so the
 *   host cannot forget it.
 * - Each run (and each subagent run, via `inheritToSubagents`) has its own nonce.
 *   The nonce is kept in `nonces` (default: in memory), so a resumed run in the
 *   same process keeps it; across processes, pass a store backed by your storage.
 *
 * Plugin order does not decide safety: the harness applies a fencing plugin's
 * `wrapTool` outermost and its `afterToolCall` last, whatever the registration
 * order, and `afterToolCall` keeps only the exact strings this plugin produced for
 * the run and fences everything else (another plugin's additions, a forged block).
 * Order only decides how tidy a fenced truncated head looks: list this plugin after
 * `truncatePlugin`.
 */
import {
  createFence,
  createNonce,
  type AnyToolDef,
  type Fence,
  type FenceOptions,
  type HarnessPlugin,
  type RunContext,
  type ToolResult,
} from "@droveragent/core";
import { Cause, Effect } from "effect";

/** Where per-run nonces live so a resumed run keeps its nonce. */
export interface NonceStore {
  get(runId: string): string | undefined;
  set(runId: string, nonce: string): void;
}

export interface UntrustedResultsOptions {
  /**
   * Tools whose results are the operator's own (not outside text). The ONLY list:
   * everything else is fenced. Default: none.
   */
  trusted?: ReadonlyArray<string>;
  /**
   * Tools that already fence their own output with this plugin's fence for the
   * run (`plugin.fenceFor(ctx.runId)`). Success results are not wrapped again;
   * errors still are. Explicit, never inferred from the output.
   */
  selfFenced?: ReadonlyArray<string>;
  /**
   * Reader tools: a stored copy of an earlier result by handle. Their result
   * `data.trusted` decides. Default `["show_tool_result"]`.
   */
  readers?: ReadonlyArray<string>;
  /** Per-string bound for the fences. */
  maxFieldChars?: FenceOptions["maxFieldChars"];
  /**
   * Nonce persistence. Default: in memory, per plugin instance (resume works in the
   * same process only; a resume that cannot find the nonce is refused).
   */
  nonces?: NonceStore;
  /** Section label for a tool's block. Default: the tool name. */
  section?: (toolName: string) => string;
}

export interface UntrustedResultsPlugin extends HarnessPlugin {
  /** The fence of a run: stable for the run, its own nonce for every run. */
  fenceFor(runId: string): Fence;
  /** Whether a tool is on the allowlist. Give this to `truncatePlugin({ isTrusted })`. */
  isTrusted(toolId: string): boolean;
}

const MAX_REMEMBERED_NONCES = 10_000;

/** Tools whose output is derived from untrusted text or can quote it: never trustable. */
export const NEVER_TRUSTED: ReadonlyArray<string> = [
  "task",
  "recall",
  "show_tool_result",
  "skill_load",
  "skill_resource",
];

/** In-memory nonce store. Least recently used goes first, so a live run keeps its nonce. */
function memoryNonces(): NonceStore {
  const map = new Map<string, string>();
  return {
    get(id) {
      const n = map.get(id);
      if (n !== undefined) {
        map.delete(id);
        map.set(id, n);
      }
      return n;
    },
    set(id, nonce) {
      map.delete(id);
      map.set(id, nonce);
      if (map.size > MAX_REMEMBERED_NONCES) map.delete(map.keys().next().value as string);
    },
  };
}

export function untrustedResultsPlugin(opts: UntrustedResultsOptions = {}): UntrustedResultsPlugin {
  const trusted = new Set(opts.trusted ?? []);
  for (const id of NEVER_TRUSTED) {
    if (trusted.has(id)) {
      throw new Error(
        `untrustedResultsPlugin: "${id}" cannot be on the trusted list: its output is derived from or quotes untrusted text.`,
      );
    }
  }
  const selfFenced = new Set(opts.selfFenced ?? []);
  for (const id of NEVER_TRUSTED) {
    if (selfFenced.has(id)) {
      throw new Error(
        `untrustedResultsPlugin: "${id}" cannot be on the selfFenced list: its output is derived from or quotes untrusted text and is fenced by this plugin.`,
      );
    }
  }
  const readers = new Set(opts.readers ?? ["show_tool_result"]);
  const nonces = opts.nonces ?? memoryNonces();
  const sectionOf = opts.section ?? ((n: string) => n);
  // Fences of LIVE runs (dropped at run end). The nonce store is always read, so a
  // live run refreshes its entry on every use, and a live run whose nonce went
  // missing is an error: minting a new one would leave the system prompt naming
  // the old nonce while results carry the new one.
  const live = new Map<string, Fence>();
  // Exact strings this plugin let through for a run's tool results: every fence block it
  // made, and the raw content of trusted results. `afterToolCall` keeps only these
  // verbatim; everything else, including a block that merely looks like one of ours
  // (the model knows the nonce from the system prompt), is fenced again. Dropped at run end.
  const known = new Map<string, Set<string>>();
  const fenceFor = (runId: string): Fence => {
    const stored = nonces.get(runId);
    const f = live.get(runId);
    if (f) {
      if (stored === f.nonce) return f;
      throw new Error(
        `untrustedResultsPlugin: the fence nonce of live run ${runId} is ${stored === undefined ? "missing from" : "different in"} the nonce store; refusing to mint a new one mid-run.`,
      );
    }
    let nonce = stored;
    if (nonce === undefined) {
      nonce = createNonce();
      nonces.set(runId, nonce);
    }
    const fresh = createFence({
      nonce,
      ...(opts.maxFieldChars !== undefined ? { maxFieldChars: opts.maxFieldChars } : {}),
    });
    live.set(runId, fresh);
    return fresh;
  };

  const remember = (runId: string, text: string): string => {
    let set = known.get(runId);
    if (!set) known.set(runId, (set = new Set()));
    if (text !== "") set.add(text);
    return text;
  };

  /** Fence `text` for a tool result of `runId`, remembering the exact block. */
  const fenceResult = (runId: string, section: string, text: string): string =>
    remember(runId, fenceFor(runId).wrapText(section, text));

  /**
   * Keep the exact strings this plugin produced for the run; fence every other non-blank
   * stretch (a forged block included: its tags are escaped and its nonce becomes [nonce]).
   */
  const refence = (runId: string, text: string): string => {
    const f = fenceFor(runId);
    const spans = [...(known.get(runId) ?? [])];
    const parts: string[] = [];
    let foreign = "";
    const flush = (): void => {
      if (foreign.trim() !== "") parts.push(f.wrapText("after-tool-call", foreign));
      else parts.push(foreign);
      foreign = "";
    };
    let i = 0;
    while (i < text.length) {
      // Earliest known span at or after i; the longest wins a tie.
      let at = -1;
      let span = "";
      for (const s of spans) {
        const k = text.indexOf(s, i);
        if (k !== -1 && (at === -1 || k < at || (k === at && s.length > span.length))) {
          at = k;
          span = s;
        }
      }
      if (at === -1) {
        foreign += text.slice(i);
        break;
      }
      foreign += text.slice(i, at);
      flush();
      parts.push(span);
      i = at + span.length;
    }
    flush();
    return parts.join("");
  };

  const isTrusted = (toolId: string): boolean => trusted.has(toolId) && !readers.has(toolId);

  const wrapTool = (tool: AnyToolDef): AnyToolDef => {
    if (readers.has(tool.id)) {
      return {
        ...tool,
        execute: (input, ctx) =>
          Effect.suspend(() => tool.execute(input, ctx)).pipe(
            Effect.map((result): ToolResult => {
              const d = result.data as { trusted?: unknown; toolId?: unknown } | undefined;
              const raw =
                d?.trusted === true && typeof d.toolId === "string" && isTrusted(d.toolId);
              return raw
                ? { ...result, content: remember(ctx.runId, result.content) }
                : {
                    ...result,
                    content: fenceResult(ctx.runId, `${sectionOf(tool.id)}-slice`, result.content),
                  };
            }),
            // A reader's failure can quote the handle or the data it looked for.
            Effect.catchAllCause((cause) =>
              Cause.isInterruptedOnly(cause)
                ? Effect.failCause(cause)
                : Effect.succeed({
                    content: fenceResult(
                      ctx.runId,
                      `${sectionOf(tool.id)}-slice`,
                      errorText(cause),
                    ),
                    isError: true,
                  }),
            ),
          ),
      };
    }
    if (isTrusted(tool.id)) {
      // Raw, but remembered: afterToolCall keeps this exact text and fences anything another
      // plugin adds to it. Errors of a trusted tool are the operator's own and pass through
      // wrapTool untouched (afterToolCall still fences them, as text it did not produce).
      return {
        ...tool,
        execute: (input, ctx) =>
          Effect.map(
            Effect.suspend(() => tool.execute(input, ctx)),
            (r) => ({
              ...r,
              content: remember(ctx.runId, r.content),
            }),
          ),
      };
    }
    const wrapSuccess = !selfFenced.has(tool.id);
    return {
      ...tool,
      execute: (input, ctx) =>
        // suspend: a tool that throws before returning an Effect is still caught below.
        Effect.suspend(() => tool.execute(input, ctx)).pipe(
          Effect.map((result) =>
            wrapSuccess
              ? {
                  ...result,
                  content: fenceResult(ctx.runId, sectionOf(tool.id), result.content),
                }
              : // self-fenced: the tool fenced its own output with this run's fence
                { ...result, content: remember(ctx.runId, result.content) },
          ),
          Effect.catchAllCause((cause) =>
            Cause.isInterruptedOnly(cause)
              ? Effect.failCause(cause)
              : Effect.succeed({
                  content: fenceResult(ctx.runId, sectionOf(tool.id), errorText(cause)),
                  isError: true,
                }),
          ),
        ),
    };
  };

  return {
    id: "untrusted-results",
    wrapTool,
    fenceFor,
    isTrusted,
    systemPromptAddendum: (ctx: RunContext) => fenceFor(ctx.runId).note(),
    wrapUntrusted: (section, text, ctx) => fenceFor(ctx.runId).wrapText(section, text),
    inheritToSubagents: true,
    // Runs after every other plugin's afterToolCall (the harness orders fence plugins
    // last). Only exact strings this plugin produced for the run pass verbatim; any other
    // text, whoever added it and whatever it looks like, is fenced (see `refence`).
    afterToolCall: (_toolName, _input, result, ctx) =>
      Effect.sync((): ToolResult => ({ ...result, content: refence(ctx.runId, result.content) })),
    onRunEnd: (_result, ctx) =>
      Effect.sync(() => {
        live.delete(ctx.runId);
        known.delete(ctx.runId);
      }),
    assertResumable(ctx) {
      // Restored history carries fences that name the old nonce. Without it the
      // new nonce would leave that history looking like ordinary text.
      if (nonces.get(ctx.runId) === undefined) {
        throw new Error(
          "untrustedResultsPlugin: cannot resume run " +
            `${ctx.runId}: its fence nonce is unknown. Pass a persistent \`nonces\` store.`,
        );
      }
    },
  };
}

function errorText(cause: Cause.Cause<unknown>): string {
  const e = Cause.squash(cause);
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  // JSON.stringify throws on a BigInt or a cycle: never let that escape the fence.
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    try {
      return String(e);
    } catch {
      return "tool failed with an unprintable error";
    }
  }
}
