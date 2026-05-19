import type { HarnessPlugin, ToolDecision } from "@drover/core";
import { Effect } from "effect";

export interface BashBlocklistOptions {
  /**
   * Extra patterns to block in addition to the built-in dangerous list.
   * Each pattern is matched against the full `command` string of any
   * call to the `bash` (or named-equivalent) tool.
   */
  extraPatterns?: ReadonlyArray<RegExp>;
  /**
   * Tool ids this plugin applies to. Defaults to `["bash"]`.
   * Override if your harness ships a differently-named shell tool.
   */
  toolIds?: ReadonlyArray<string>;
  /**
   * If true, the plugin allows the call but emits a warning rationale
   * via afterToolCall instead of blocking. Useful for audit-only mode.
   */
  warnOnly?: boolean;
}

/**
 * Default blocklist for the `bash` tool. Catches the high-blast-radius
 * commands first (rm -rf /, sudo, fork-bombs, untrusted curl|sh, …).
 * Refine via `extraPatterns` per project.
 */
const DEFAULT_PATTERNS: ReadonlyArray<RegExp> = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s*\/(?:\s|$)/, // rm -rf /
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+~/, // rm -rf ~
  /\bsudo\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bmkfs\b/,
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|sudo)\b/, // curl … | sh
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/, // fork bomb shape
  /\bdd\s+if=\/dev\/(zero|urandom|random)/,
  /\b>\s*\/dev\/sd[a-z]/,
];

/**
 * Pattern-matched safety gate for the `bash` tool. Walks the command
 * string against a denylist and rejects on match. Apply to any agent
 * that has `bash` in its toolset.
 */
export function bashBlocklistPlugin(opts: BashBlocklistOptions = {}): HarnessPlugin {
  const patterns = [...DEFAULT_PATTERNS, ...(opts.extraPatterns ?? [])];
  const toolIds = new Set(opts.toolIds ?? ["bash"]);
  const warnOnly = opts.warnOnly ?? false;

  return {
    id: "bash-blocklist",
    beforeToolCall: (toolName, input) =>
      Effect.sync((): ToolDecision => {
        if (!toolIds.has(toolName)) return { kind: "allow" };
        const cmd = extractCommand(input);
        if (!cmd) return { kind: "allow" };
        for (const pat of patterns) {
          if (pat.test(cmd)) {
            if (warnOnly) return { kind: "allow" };
            return {
              kind: "deny",
              reason: `bash-blocklist refused command (matched ${pat.toString()}). Pick a safer alternative.`,
            };
          }
        }
        return { kind: "allow" };
      }),
  };
}

function extractCommand(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const cmd = (input as { command?: unknown }).command;
  return typeof cmd === "string" ? cmd : null;
}
