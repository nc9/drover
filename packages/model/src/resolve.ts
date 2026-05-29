import type { CacheRetention, ModelSpec, ReasoningLevel } from "@droveragent/core";
import { ModelError } from "@droveragent/core";
import { Effect } from "effect";
import { getModel, getProviders, getModels } from "@mariozechner/pi-ai";
import type { KnownApi, Model } from "@mariozechner/pi-ai";

import { DEFAULT_ALIASES, type AliasEntry } from "./aliases.ts";

/** Output of resolution — everything pi-agent-core needs to make a call. */
export interface ResolvedModel {
  model: Model<KnownApi>;
  apiKey: string;
  reasoning?: ReasoningLevel;
  temperature?: number;
  maxTokens?: number;
  cacheRetention?: CacheRetention;
}

/** Normalised view of a `ModelSpec` after slug parsing. */
interface NormalisedSpec {
  name: string;
  reasoning?: ReasoningLevel;
  temperature?: number;
  maxTokens?: number;
  cacheRetention?: CacheRetention;
}

const VALID_REASONING: ReadonlySet<ReasoningLevel> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function parseSpec(spec: ModelSpec): NormalisedSpec {
  if (typeof spec === "string") {
    const colonIdx = spec.lastIndexOf(":");
    if (colonIdx > 0) {
      const candidate = spec.slice(colonIdx + 1);
      if (VALID_REASONING.has(candidate as ReasoningLevel)) {
        return { name: spec.slice(0, colonIdx), reasoning: candidate as ReasoningLevel };
      }
    }
    return { name: spec };
  }
  const out: NormalisedSpec = { name: spec.name };
  if (spec.reasoning) out.reasoning = spec.reasoning;
  if (spec.temperature !== undefined) out.temperature = spec.temperature;
  if (spec.maxTokens !== undefined) out.maxTokens = spec.maxTokens;
  if (spec.cacheRetention) out.cacheRetention = spec.cacheRetention;
  return out;
}

/**
 * Search every pi-ai provider for a model whose id matches `name`. Used
 * when the name isn't an alias — lets callers use `"google/gemini-2.5-flash"`
 * directly without bothering with a provider param.
 */
function findByModelId(name: string): AliasEntry | null {
  for (const provider of getProviders()) {
    const models = getModels(provider);
    for (const m of models) {
      if (m.id === name) return { provider, modelId: m.id };
    }
  }
  return null;
}

const ENV_KEY_BY_PROVIDER: Readonly<Record<string, ReadonlyArray<string>>> = {
  openrouter: ["OPENROUTER_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
};

function readApiKey(provider: string, env: Readonly<Record<string, string | undefined>>): string | null {
  const keys = ENV_KEY_BY_PROVIDER[provider] ?? [];
  for (const k of keys) {
    const v = env[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * An already-constructed model + key. A host with its own role resolver
 * (provider connections, encrypted credentials) injects these so drover
 * skips alias / slug / builtin lookup and env-var key reading entirely.
 */
export interface PreResolvedModel {
  model: Model<KnownApi>;
  apiKey: string;
}

export interface ResolveOptions {
  runId: string;
  aliases?: Readonly<Record<string, AliasEntry>>;
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Pre-resolved models keyed by spec name (the name part of `ModelSpec`,
   * with any `:reasoning` suffix stripped). Checked BEFORE the alias /
   * slug / builtin lookup. Per-call `reasoning` / `temperature` / etc.
   * from the spec still apply on top of the injected model.
   */
  preResolved?: ReadonlyMap<string, PreResolvedModel>;
}

/**
 * Effectful resolver. Lookup order:
 *   0. Pre-resolved map (host-injected models) — see `ResolveOptions.preResolved`
 *   1. Alias map (defaults ∪ per-call override)
 *   2. Provider-prefixed slug:   "openrouter:google/gemini-2.5-flash-lite"
 *   3. Global pi-ai model id:    "google/gemini-2.5-flash-lite"
 *
 * Failures surface as `ModelError` with a typed `reason`.
 */
export function resolveModel(
  spec: ModelSpec,
  opts: ResolveOptions,
): Effect.Effect<ResolvedModel, ModelError, never> {
  return Effect.gen(function* () {
    const norm = parseSpec(spec);

    const pre = opts.preResolved?.get(norm.name);
    if (pre) {
      const result: ResolvedModel = { model: pre.model, apiKey: pre.apiKey };
      if (norm.reasoning) result.reasoning = norm.reasoning;
      if (norm.temperature !== undefined) result.temperature = norm.temperature;
      if (norm.maxTokens !== undefined) result.maxTokens = norm.maxTokens;
      if (norm.cacheRetention) result.cacheRetention = norm.cacheRetention;
      return result;
    }

    const aliases = opts.aliases ?? DEFAULT_ALIASES;
    const env = opts.env ?? (process.env as Record<string, string | undefined>);

    let entry: AliasEntry | null = aliases[norm.name] ?? null;
    if (!entry && norm.name.includes(":")) {
      const [provider, ...rest] = norm.name.split(":");
      const modelId = rest.join(":");
      if (provider && modelId) entry = { provider, modelId };
    }
    if (!entry) entry = findByModelId(norm.name);
    if (!entry) {
      return yield* Effect.fail(
        new ModelError({
          runId: opts.runId,
          modelName: norm.name,
          reason: "routing_miss",
          message: `unknown model name "${norm.name}" — not in aliases and not a pi-ai builtin id`,
        }),
      );
    }

    let model: Model<KnownApi>;
    try {
      model = getModel(entry.provider as never, entry.modelId as never);
    } catch (err) {
      return yield* Effect.fail(
        new ModelError({
          runId: opts.runId,
          modelName: norm.name,
          reason: "routing_miss",
          message: `pi-ai getModel("${entry.provider}", "${entry.modelId}") failed: ${(err as Error).message}`,
        }),
      );
    }

    const apiKey = readApiKey(entry.provider, env);
    if (!apiKey) {
      return yield* Effect.fail(
        new ModelError({
          runId: opts.runId,
          modelName: norm.name,
          reason: "auth",
          message: `no API key for provider "${entry.provider}" — checked env vars ${(ENV_KEY_BY_PROVIDER[entry.provider] ?? []).join(", ") || "(none registered)"}`,
        }),
      );
    }

    const reasoning = norm.reasoning ?? entry.reasoning;
    const result: ResolvedModel = { model, apiKey };
    if (reasoning) result.reasoning = reasoning;
    if (norm.temperature !== undefined) result.temperature = norm.temperature;
    if (norm.maxTokens !== undefined) result.maxTokens = norm.maxTokens;
    if (norm.cacheRetention) result.cacheRetention = norm.cacheRetention;
    return result;
  });
}
