import type { ReasoningLevel } from "@drover/core";

/**
 * Resolved entry the resolver returns. Pi-ai's `getModel(provider, modelId)`
 * needs both pieces; aliases collapse them.
 */
export interface AliasEntry {
  provider: string;
  modelId: string;
  /** Default reasoning level when the spec omits a `:level` suffix. */
  reasoning?: ReasoningLevel;
}

/**
 * Default alias map. Tuned for cheap, tool-capable runs on 2026-era models.
 * All routes go through OpenRouter so a single `OPENROUTER_API_KEY` unlocks
 * the whole map.
 *
 *   default  — Google Gemini 3.1 Flash Lite Preview ($0.25/$1.50, 1M ctx, reasoning)
 *   cheap    — alias of default
 *   flash    — alias of default
 *   grok     — x-ai/grok-4-fast                     ($0.20/$0.50, 2M ctx, reasoning) — currently the cheapest reasoning model
 *   mini     — openai/gpt-5-mini                    ($0.25/$2,    400K ctx, reasoning)
 *   nano     — openai/gpt-5-nano                    ($0.05/$0.40, 400K ctx)
 *   haiku    — anthropic/claude-haiku-4.5           ($1/$5,       200K ctx, reasoning)
 *   sonnet   — anthropic/claude-sonnet-4.6          (frontier tier — expensive)
 *   deepseek — deepseek/deepseek-v3.2               ($0.25/$0.38, 131K ctx, reasoning)
 *   glm      — z-ai/glm-4.7                         ($0.38/$1.74, 200K ctx, reasoning)
 *
 * Projects override with `withAliases({...})` or replace entirely.
 */
export const DEFAULT_ALIASES: Readonly<Record<string, AliasEntry>> = {
  default: { provider: "openrouter", modelId: "google/gemini-3.1-flash-lite-preview" },
  cheap: { provider: "openrouter", modelId: "google/gemini-3.1-flash-lite-preview" },
  flash: { provider: "openrouter", modelId: "google/gemini-3.1-flash-lite-preview" },
  grok: { provider: "openrouter", modelId: "x-ai/grok-4-fast" },
  mini: { provider: "openrouter", modelId: "openai/gpt-5-mini" },
  nano: { provider: "openrouter", modelId: "openai/gpt-5-nano" },
  haiku: { provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" },
  sonnet: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4.6" },
  deepseek: { provider: "openrouter", modelId: "deepseek/deepseek-v3.2" },
  glm: { provider: "openrouter", modelId: "z-ai/glm-4.7" },
};

/** Merge user overrides on top of defaults; later keys win. */
export function withAliases(
  ...layers: ReadonlyArray<Readonly<Record<string, AliasEntry>>>
): Readonly<Record<string, AliasEntry>> {
  return Object.freeze(Object.assign({}, DEFAULT_ALIASES, ...layers));
}
