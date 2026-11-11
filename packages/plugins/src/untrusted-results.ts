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
 * order, and `afterToolCall` fences anything another plugin added or changed
 * outside a fence block. Order only decides how tidy a fenced truncated head looks:
 * list this plugin after `truncatePlugin`.
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
  // Result contents this plugin produced, per run: `afterToolCall` passes those
  // through unchanged and fences anything another plugin added outside a block.
  const produced = new Map<string, Set<string>>();

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

  const record = (runId: string, result: ToolResult): ToolResult => {
    let set = produced.get(runId);
    if (!set) produced.set(runId, (set = new Set()));
    set.add(result.content);
    return result;
  };

  // Every non-blank stretch of `text` outside this run's fence blocks becomes its own block.
  const fenceOutside = (f: Fence, text: string): string => {
    const open = `<${f.tag} section="`;
    const close = `</${f.tag}>`;
    const parts: string[] = [];
    let i = 0;
    while (i < text.length) {
      const start = text.indexOf(open, i);
      const end = start === -1 ? -1 : text.indexOf(close, start);
      const outside = text.slice(i, start === -1 || end === -1 ? text.length : start);
      if (outside.trim() !== "") parts.push(f.wrapText("after-tool-call", outside));
      else if (outside !== "") parts.push(outside);
      if (start === -1 || end === -1) break;
      parts.push(text.slice(start, end + close.length));
      i = end + close.length;
    }
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
                ? result
                : {
                    ...result,
                    content: fenceFor(ctx.runId).wrapText(
                      `${sectionOf(tool.id)}-slice`,
                      result.content,
                    ),
                  };
            }),
            // A reader's failure can quote the handle or the data it looked for.
            Effect.catchAllCause((cause) =>
              Cause.isInterruptedOnly(cause)
                ? Effect.failCause(cause)
                : Effect.succeed({
                    content: fenceFor(ctx.runId).wrapText(
                      `${sectionOf(tool.id)}-slice`,
                      errorText(cause),
                    ),
                    isError: true,
                  }),
            ),
            Effect.map((r) => record(ctx.runId, r)),
          ),
      };
    }
    if (isTrusted(tool.id)) return tool; // errors of a trusted tool are the operator's own
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
                  content: fenceFor(ctx.runId).wrapText(sectionOf(tool.id), result.content),
                }
              : result,
          ),
          Effect.catchAllCause((cause) =>
            Cause.isInterruptedOnly(cause)
              ? Effect.failCause(cause)
              : Effect.succeed({
                  content: fenceFor(ctx.runId).wrapText(sectionOf(tool.id), errorText(cause)),
                  isError: true,
                }),
          ),
          Effect.map((r) => record(ctx.runId, r)),
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
    // last). A result this plugin produced and nobody changed passes as is; anything
    // else (another plugin rewrote it, or it never went through wrapTool) has every
    // stretch outside this run's fence blocks fenced. Trusted tools pass.
    afterToolCall: (toolName, _input, result, ctx) =>
      Effect.sync((): ToolResult => {
        if (isTrusted(toolName)) return result;
        if (produced.get(ctx.runId)?.delete(result.content)) return result;
        return { ...result, content: fenceOutside(fenceFor(ctx.runId), result.content) };
      }),
    onRunEnd: (_result, ctx) =>
      Effect.sync(() => {
        live.delete(ctx.runId);
        produced.delete(ctx.runId);
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
