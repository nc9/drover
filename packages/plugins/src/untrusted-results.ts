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
 * Plugin order does not decide safety (reads are fenced from the result's own
 * provenance), only how tidy a fenced truncated head looks: list this plugin after
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
  const readers = new Set(opts.readers ?? ["show_tool_result"]);
  const nonces = opts.nonces ?? memoryNonces();
  const sectionOf = opts.section ?? ((n: string) => n);
  const fences = new Map<string, Fence>();

  const fenceFor = (runId: string): Fence => {
    let f = fences.get(runId);
    if (!f) {
      let nonce = nonces.get(runId);
      if (nonce === undefined) {
        nonce = createNonce();
        nonces.set(runId, nonce);
      }
      f = createFence({
        nonce,
        ...(opts.maxFieldChars !== undefined ? { maxFieldChars: opts.maxFieldChars } : {}),
      });
      // A cache only: an evicted fence is rebuilt from the same stored nonce.
      fences.set(runId, f);
      if (fences.size > MAX_REMEMBERED_NONCES) fences.delete(fences.keys().next().value as string);
    }
    return f;
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
  return e instanceof Error
    ? e.message
    : typeof e === "string"
      ? e
      : (JSON.stringify(e) ?? String(e));
}
