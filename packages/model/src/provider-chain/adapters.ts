import type { Api, Model, OpenAICompletionsCompat } from "@mariozechner/pi-ai";

import type { ChainStreamFn, PreparedCall, ProviderSpec } from "./chain.ts";

/** Id mapping shared by the shipped adapters. */
export interface ModelMapping {
  /** Explicit canonical id -> provider id. Checked first; `null` marks the model as not served. */
  modelMap?: Readonly<Record<string, string | null>>;
  /** Fallback when `modelMap` has no entry. Return `null` to skip this provider for the model. */
  mapModel?: (canonicalId: string) => string | null;
}

function resolveMapping(m: ModelMapping, fallback: (id: string) => string | null) {
  return (canonicalId: string): string | null => {
    if (m.modelMap && canonicalId in m.modelMap) return m.modelMap[canonicalId] ?? null;
    return (m.mapModel ?? fallback)(canonicalId);
  };
}

export interface OpenRouterOptions extends ModelMapping {
  apiKey: string;
  /** Default `https://openrouter.ai/api/v1`. */
  baseUrl?: string;
  /** Attribution headers (`HTTP-Referer`, `X-Title`) and anything else. */
  headers?: Record<string, string>;
  /** Provider name in traces and usage. Default `openrouter`. */
  name?: string;
  /** Replace the transport (tests). */
  stream?: ChainStreamFn;
}

/** OpenRouter: canonical ids are its own, so the default mapping is the identity. */
export function openRouter(opts: OpenRouterOptions): ProviderSpec {
  const name = opts.name ?? "openrouter";
  return {
    name,
    mapModel: resolveMapping(opts, (id) => id),
    prepare(canonical: Model<Api>, mappedId: string): PreparedCall {
      const model = {
        ...canonical,
        id: mappedId,
        api: "openai-completions",
        provider: "openrouter",
        baseUrl: opts.baseUrl ?? "https://openrouter.ai/api/v1",
        headers: undefined,
      } as unknown as Model<Api>;
      return { model, apiKey: opts.apiKey, ...(opts.headers ? { headers: opts.headers } : {}) };
    },
    ...(opts.stream ? { stream: opts.stream } : {}),
  };
}

export interface CloudflareAiGatewayOptions extends ModelMapping {
  accountId: string;
  gatewayId: string;
  /**
   * The gateway's own token, sent as `cf-aig-authorization`. Required: the
   * adapter always sends it, so turn gateway authentication on.
   */
  token: string;
  /**
   * The upstream provider's key, sent as `Authorization`, when the gateway does
   * not hold it (no BYOK, no unified billing).
   */
  upstreamApiKey?: string;
  /** Upstream provider path segment. Default `openai` (the OpenAI-compatible endpoint). */
  upstream?: string;
  /** Replace the gateway origin. Default `https://gateway.ai.cloudflare.com`. */
  origin?: string;
  /** Extra headers (`cf-aig-metadata`, `cf-aig-cache-ttl`, ...). */
  headers?: Record<string, string>;
  /** Override pi-ai's OpenAI-compatible request quirks. Default sends `max_completion_tokens`. */
  compat?: OpenAICompletionsCompat;
  name?: string;
  stream?: ChainStreamFn;
}

/**
 * Cloudflare AI Gateway through its OpenAI-compatible endpoint
 * (`<origin>/v1/<account>/<gateway>/openai`). The default mapping serves
 * OpenAI models only: `openai/gpt-5-mini` becomes `gpt-5-mini`, any other
 * vendor's id is skipped (the gateway has other endpoints for them: set
 * `upstream` and `mapModel` to use one).
 */
export function cloudflareAiGateway(opts: CloudflareAiGatewayOptions): ProviderSpec {
  const name = opts.name ?? "cloudflare-ai-gateway";
  const upstream = opts.upstream ?? "openai";
  const origin = (opts.origin ?? "https://gateway.ai.cloudflare.com").replace(/\/+$/, "");
  const baseUrl = `${origin}/v1/${encodeURIComponent(opts.accountId)}/${encodeURIComponent(opts.gatewayId)}/${encodeURIComponent(upstream)}`;
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.upstreamApiKey) headers.Authorization = `Bearer ${opts.upstreamApiKey}`;
  return {
    name,
    mapModel: resolveMapping(opts, (id) =>
      id.startsWith("openai/") ? id.slice("openai/".length) : null,
    ),
    prepare(canonical: Model<Api>, mappedId: string): PreparedCall {
      const model = {
        ...canonical,
        id: mappedId,
        api: "openai-completions",
        // pi-ai sends the key as `cf-aig-authorization` for this provider name.
        provider: "cloudflare-ai-gateway",
        baseUrl,
        headers: undefined,
        compat: opts.compat ?? {
          maxTokensField: "max_completion_tokens",
          supportsReasoningEffort: true,
        },
      } as unknown as Model<Api>;
      return { model, apiKey: opts.token, ...(Object.keys(headers).length ? { headers } : {}) };
    },
    ...(opts.stream ? { stream: opts.stream } : {}),
  };
}
