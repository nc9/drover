/**
 * Tool-result truncation plugin.
 *
 * Caps each tool result's `content` at `maxBytes`; the overflow is stashed
 * in a per-run store keyed by the invocation's `toolUseId`, retrievable via
 * the contributed `show_tool_result` tool.
 *
 * Why: large tool outputs (long bash logs, huge file reads, dense grep hits)
 * blow the context window AND degrade prompt caching by churning the message
 * list. Capping with a structured affordance lets the model ask for more
 * bytes only when it actually needs them.
 *
 * `truncatePlugin()` returns `{ plugin, store }` so a caller can share the
 * `TruncateStore` with another plugin (e.g. dedup, which re-stashes overflow
 * on cache hits).
 */
import { type Static, Type } from "@sinclair/typebox";
import { defineTool, type AnyToolDef, type HarnessPlugin, type ToolDef } from "@droveragent/core";
import { Effect } from "effect";

export const MAX_RESULT_BYTES = 8192;
export const TRUNCATE_HEAD_BYTES = 4096;

/** Provenance written with an entry, by the code that knows which tool produced it. */
export interface TruncateEntryMeta {
  /** True only when the producing tool was positively declared trusted. Absent means untrusted. */
  trusted?: boolean;
  /** Run that stored the entry. The entry is only readable by that run (or via a legacy unscoped read). */
  runId?: string;
  /** Tool that produced the content. */
  toolId?: string;
}

export interface TruncateEntry extends TruncateEntryMeta {
  fullText: string;
  totalBytes: number;
}

export interface TruncateStore {
  /**
   * Stash the full text under `toolUseId`. Called only on truncation. The optional
   * third argument is additive: absent means "untrusted, no run" (fail closed).
   */
  set(toolUseId: string, fullText: string, meta?: TruncateEntryMeta): void;
  /**
   * Read back an entry. With `runId`, only that run's entry (or a legacy entry
   * stored without a run) is visible; without it, the first entry with that id.
   */
  get(toolUseId: string, runId?: string): TruncateEntry | undefined;
  /** Diagnostic: how many entries are stored. */
  size(): number;
}

const SEP = "\u0000";

export function makeTruncateStore(): TruncateStore {
  const map = new Map<string, TruncateEntry>();
  return {
    set(id, text, meta) {
      const entry: TruncateEntry = { fullText: text, totalBytes: Buffer.byteLength(text, "utf8") };
      if (meta?.trusted === true) entry.trusted = true;
      if (meta?.runId !== undefined) entry.runId = meta.runId;
      if (meta?.toolId !== undefined) entry.toolId = meta.toolId;
      map.set(`${meta?.runId ?? ""}${SEP}${id}`, entry);
    },
    get(id, runId) {
      if (runId !== undefined) return map.get(`${runId}${SEP}${id}`) ?? map.get(`${SEP}${id}`);
      for (const [k, v] of map) if (k.endsWith(`${SEP}${id}`)) return v;
      return undefined;
    },
    size() {
      return map.size;
    },
  };
}

const ShowToolResultInput = Type.Object({
  toolUseId: Type.String({
    minLength: 1,
    description:
      "The toolUseId from the truncation marker in a previous tool result. Each call records its own id.",
  }),
  byteRange: Type.Optional(
    Type.Array(Type.Integer({ minimum: 0 }), {
      minItems: 2,
      maxItems: 2,
      description:
        "[start, end] byte range to read — start inclusive, end exclusive. Omit to read from the head boundary to the end (the part you have not already seen).",
    }),
  ),
});

function showToolResultTool(
  store: TruncateStore,
  headBytes: number,
): ToolDef<typeof ShowToolResultInput> {
  return defineTool({
    id: "show_tool_result",
    description:
      "Read more of a previously-truncated tool result. The harness truncates large tool outputs; this returns additional bytes from the stored full result. Pass the toolUseId that appeared in the truncation marker.",
    inputSchema: ShowToolResultInput,
    execute: (input: Static<typeof ShowToolResultInput>, ctx) =>
      Effect.sync(() => {
        const entry = store.get(input.toolUseId, ctx.runId);
        if (!entry) {
          return {
            content: `ERROR: no stored result for toolUseId "${input.toolUseId}". Either it was never truncated, or it belongs to a different run. Truncated results carry a marker like \`show_tool_result({ toolUseId: "..." })\` — copy that exact id.`,
            isError: true,
            data: { error: "not_found", toolUseId: input.toolUseId },
          };
        }
        const fullBuf = Buffer.from(entry.fullText, "utf8");
        const total = fullBuf.length;
        let start = headBytes;
        let end = total;
        if (input.byteRange) {
          start = Math.min(input.byteRange[0] ?? 0, total);
          end = Math.min(input.byteRange[1] ?? total, total);
        }
        if (start >= end) {
          return {
            content: `ERROR: byteRange [${start}, ${end}) is empty (total=${total}).`,
            isError: true,
            data: { error: "empty_range", start, end, total },
          };
        }
        const slice = fullBuf.subarray(start, end).toString("utf8");
        const remaining = total - end;
        const tail =
          remaining > 0
            ? `\n\n[showing bytes ${start}-${end} of ${total}; ${remaining} bytes remain]`
            : `\n\n[showing bytes ${start}-${end} of ${total}; end of content]`;
        return {
          content: slice + tail,
          data: { start, end, total, remaining },
        };
      }),
  });
}

export interface TruncateOptions {
  /** Truncate results larger than this many bytes. Default 8192. */
  maxBytes?: number;
  /** Bytes of head to keep when truncating. Default 4096. */
  headBytes?: number;
  /** Reuse an existing store (e.g. shared with the dedup plugin). */
  store?: TruncateStore;
  /**
   * Tools whose results are positively trusted (not outside text). Stored with
   * each entry at the moment it is written. Every other tool's overflow is
   * stored untrusted, so a reader that honours the flag (see
   * `untrustedResultsPlugin`) fences it. Default: none.
   */
  trustedTools?: ReadonlyArray<string>;
}

export interface TruncatePlugin {
  plugin: HarnessPlugin;
  store: TruncateStore;
}

/**
 * Build the truncation plugin. Returns the plugin plus its store so the
 * store can be shared (the dedup plugin re-stashes overflow on cache hits).
 *
 * Compose order matters: list `truncate` before `dedup` in `spec.plugins`
 * so `dedup`'s `wrapTool` sits outside `truncate`'s and caches the already
 * truncated result.
 */
export function truncatePlugin(opts: TruncateOptions = {}): TruncatePlugin {
  const store = opts.store ?? makeTruncateStore();
  const maxBytes = opts.maxBytes ?? MAX_RESULT_BYTES;
  const headBytes = opts.headBytes ?? TRUNCATE_HEAD_BYTES;
  const trustedTools = new Set(opts.trustedTools ?? []);

  const wrapTool = (tool: AnyToolDef): AnyToolDef => {
    // Don't truncate show_tool_result itself — its byteRange already lets
    // the model bound the window, and re-stashing would chain markers.
    if (tool.id === "show_tool_result") return tool;
    return {
      ...tool,
      execute: (input: unknown, ctx) =>
        Effect.map(tool.execute(input, ctx), (result) => {
          const bytes = Buffer.byteLength(result.content, "utf8");
          if (bytes <= maxBytes) return result;
          store.set(ctx.toolUseId, result.content, {
            trusted: trustedTools.has(tool.id),
            runId: ctx.runId,
            toolId: tool.id,
          });
          const head = Buffer.from(result.content, "utf8").subarray(0, headBytes).toString("utf8");
          return {
            ...result,
            content:
              `${head}\n\n[truncated — tool result was ${bytes} bytes; first ${headBytes} bytes shown. ` +
              `Call show_tool_result({ toolUseId: "${ctx.toolUseId}", byteRange: [START, END] }) to read more.]`,
          };
        }),
    };
  };

  return {
    store,
    plugin: {
      id: "truncate",
      tools: [showToolResultTool(store, headBytes)],
      wrapTool,
    },
  };
}
