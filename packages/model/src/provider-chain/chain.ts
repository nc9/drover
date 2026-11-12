import type { BalanceSource, ProviderFailureClass } from "@droveragent/core";
import {
  createAssistantMessageEventStream,
  getModel,
  getModels,
  streamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";

import { readApiKey, type PreResolvedModel } from "../resolve.ts";
import {
  FAILOVER,
  classifyFailure,
  structuredFromBody,
  type ProviderFailure,
  type RawFailure,
} from "./classify.ts";
import { applyBilledCost, isOpenRouter, withUsageInclude } from "./provider-cost.ts";
import { rawFromResponse, startAttemptTap, type AttemptTap } from "./response-tap.ts";

/** pi-agent-core's `StreamFn`. */
export type ChainStreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** What the chain does after a failure of a class: see `ProviderChainOptions.actions`. */
export type FailoverAction = "stop" | "next" | "skip";

/** What the harness turns into a `provider_failover` event. */
export interface ProviderFailoverNotice {
  action: "retry" | "failover" | "exhausted";
  /**
   * On `failover` and `exhausted`: whether `from` is now skipped (tried last) for the rest
   * of the run (`true`), or was only passed over for this call (`false`).
   */
  benched?: boolean;
  from: string;
  to: string | null;
  failureClass: ProviderFailureClass;
  status: number | null;
  code?: string;
  waitMs?: number;
}
export type ProviderFailoverListener = (notice: ProviderFailoverNotice) => void;

/**
 * A chain provider given as settings instead of (or on top of) environment variables: a
 * Worker's bindings, one tenant's credentials, a test's fakes. Every setting falls back to the
 * environment only when absent, and `useEnv: false` turns the environment off for this entry.
 * Credentials and header values given here are sent to the provider and nowhere else: drover
 * never puts them in events, errors, the chain record, storage or traces. With
 * `includeProviderText: true` the provider's own error text is kept, and a provider that echoes
 * a request header or key back in its error body would carry it into the error message.
 */
export interface ProviderEntry {
  /** pi-ai provider name: its registry entry, and the default env var for its key. */
  name: string;
  /** The API key. Default: `apiKeys[name]`, then the provider's env var. */
  apiKey?: string;
  /**
   * Base URL; `{PLACEHOLDER}`s (`[A-Z0-9_]`) are filled from `vars`, then the environment (not
   * with `useEnv: false`). A value must be letters, digits, `_`, `.` or `-`; an unfilled or
   * unusable placeholder refuses the provider for the call. Default: the provider's base URL in
   * pi-ai's registry (also for a model declared in `models`).
   */
  baseUrl?: string;
  /** Values for `{PLACEHOLDER}`s in the base URL (e.g. `CLOUDFLARE_ACCOUNT_ID`). */
  vars?: Readonly<Record<string, string>>;
  /**
   * Extra request headers, merged over the model's. On OpenAI-compatible providers an
   * `Authorization` header here replaces the `apiKey` bearer. On `cloudflare-ai-gateway`, pi-ai
   * sets `cf-aig-authorization` from `apiKey` after these, so put the gateway token in `apiKey`;
   * a `cf-aig-authorization` header here has no effect.
   */
  headers?: Readonly<Record<string, string>>;
  /**
   * Models for this provider, by canonical id, in one place: a provider id (string), `null`
   * (not served here), or a model declaration for one pi-ai's registry does not list
   * (`{ id, contextWindow?, maxTokens?, cost?, ... }`; api `openai-completions` by default).
   */
  models?: Readonly<Record<string, string | null | (Partial<Model<Api>> & { id: string })>>;
  /**
   * AWS region, for `amazon-bedrock` only (`eu-west-1`): the runtime endpoint
   * (`https://bedrock-runtime.<region>.amazonaws.com`, unless `baseUrl` is set) and the request's
   * region. Default: `AWS_REGION`, then `AWS_DEFAULT_REGION` from the environment. A model
   * declared in `models` needs a region or a `baseUrl`.
   */
  region?: string;
  /** Read the environment for anything not given here. Default true. */
  useEnv?: boolean;
}

export interface ProviderChainOptions {
  /**
   * Providers in order of preference: pi-ai provider names (`["openrouter",
   * "cloudflare-ai-gateway"]`), or `ProviderEntry` settings objects, or a mix.
   */
  providers: ReadonlyArray<string | ProviderEntry>;
  /**
   * Spec model name -> canonical model id (OpenRouter style, `openai/gpt-4o-mini`). These become the
   * harness's `preResolvedModels`; any other name resolves through the normal resolver.
   */
  models?: Readonly<Record<string, string>>;
  /**
   * Canonical id -> id per provider, as data. `null` = that provider does not serve it. Without an
   * entry the id is used as is, except that `cloudflare-ai-gateway` drops a leading `openai/`
   * (its OpenAI models are listed unprefixed in pi-ai's registry).
   */
  ids?: Readonly<Record<string, Readonly<Record<string, string | null>>>>;
  /** Per-provider patch of the pi-ai model, e.g. a request quirk: `{ "cloudflare-ai-gateway": { compat: { ... } } }`. */
  overrides?: Readonly<Record<string, Partial<Model<Api>>>>;
  /** Models pi-ai's registry does not list yet (checked first). */
  extraModels?: ReadonlyArray<Model<Api>>;
  /** API keys by provider; default: the resolver's env vars (`OPENROUTER_API_KEY`, `CLOUDFLARE_API_KEY`, ...). */
  apiKeys?: Readonly<Record<string, string>>;
  /** Environment for keys and the gateway's `{CLOUDFLARE_ACCOUNT_ID}` / `{CLOUDFLARE_GATEWAY_ID}` placeholders. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Longest `Retry-After` (ms) waited out before one retry on the same provider. Default 10 000. */
  maxRateLimitWaitMs?: number;
  /**
   * Report the provider-billed cost (OpenRouter's `usage.cost`) as each call's
   * `usage.cost.total`, so `Usage.costUsd`, `usageByProvider` and `quota.maxCostUsd`
   * run on billed cost. Adds `usage: { include: true }` to OpenRouter requests only;
   * other providers keep pi-ai's list-price cost. Uses the same response tap as the
   * structured errors. Default off.
   */
  billedCost?: boolean;
  /**
   * The action per failure class, overriding the defaults (`FAILOVER`):
   * - `"stop"`: end the call here; no other provider is tried.
   * - `"next"`: try the next provider for THIS call only; this provider is asked first again
   *   on the next call.
   * - `"skip"`: try the next provider and skip this one (try it last) for the rest of the run.
   * E.g. `{ invalid_request: "next" }` when providers differ in the model aliases or request
   * fields they accept. Omitted classes keep the default. A rate limit keeps its one in-place
   * retry under `"next"` and `"skip"`.
   */
  actions?: Readonly<Partial<Record<ProviderFailureClass, FailoverAction>>>;
  /** Put the providers' own text in the final error message. Off: it can quote the prompt. */
  includeProviderText?: boolean;
  /** Replace a provider's transport (tests, proxies), by provider name. */
  streams?: Readonly<Record<string, ChainStreamFn>>;
  /** Wait for a retry (tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Optional balance capability per provider (by provider name), e.g.
   * `{ openrouter: openRouterBalance({ apiKey }) }`. Not used for failover; exposed in chain
   * order by `balanceSources()` so a balance preflight can read the providers configured here.
   */
  balances?: Readonly<Record<string, BalanceSource>>;
}

export interface ProviderChain {
  readonly providers: readonly string[];
  /** The transport for ONE run; failover notices go to `listener`. A provider benched in this run stays benched only in it. */
  forRun(listener?: ProviderFailoverListener): ChainStreamFn;
  /** `options.models` as harness `preResolvedModels`. The key is a placeholder: each call uses its provider's key. */
  preResolvedModels(): Map<string, PreResolvedModel>;
  /**
   * The `balances` of this chain's providers, in chain order; a provider without one is skipped.
   * Pass the chain itself as `balancePreflightPlugin({ sources: chain })`.
   */
  balanceSources(): ReadonlyArray<BalanceSource>;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), {
      once: true,
    });
  });

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function errorMessage(
  model: Model<Api>,
  provider: string,
  text: string,
  stopReason: "error" | "aborted" = "error",
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason,
    errorMessage: text,
    timestamp: Date.now(),
  };
}

/** `provider: class (status code)`, plus the provider's own text only when opted in. */
function describeFailure(x: ProviderFailure, includeText: boolean): string {
  const detail = [x.status, x.code].filter((v) => v !== null && v !== undefined).join(" ");
  const head = `${x.provider}: ${x.failureClass}${detail ? ` (${detail})` : ""}`;
  return includeText && x.message ? `${head}: ${x.message}` : head;
}

/** Class, status and allow-listed code per failure: the fields the harness builds its error from. */
function failureDiagnostics(
  failures: readonly ProviderFailure[],
  benchedBy: ReadonlySet<ProviderFailure> = new Set(),
): NonNullable<AssistantMessage["diagnostics"]> {
  return failures.map((x) => ({
    type: "provider_failure",
    timestamp: Date.now(),
    details: {
      provider: x.provider,
      failureClass: x.failureClass,
      status: x.status,
      benched: benchedBy.has(x),
      ...(x.code ? { code: x.code } : {}),
      ...(x.retryAfterMs !== undefined ? { retryAfterMs: x.retryAfterMs } : {}),
      ...(x.headers ? { headers: x.headers } : {}),
    },
  }));
}

/** Structured hints a thrown transport error may carry (SDK errors, custom fetchers). */
function rawFromThrown(err: unknown): RawFailure {
  const e = err as {
    message?: unknown;
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    retryAfterMs?: unknown;
    error?: unknown;
  } | null;
  const raw: RawFailure = { message: typeof e?.message === "string" ? e.message : String(err) };
  const status = typeof e?.status === "number" ? e.status : e?.statusCode;
  if (typeof status === "number") raw.status = status;
  Object.assign(raw, structuredFromBody({ error: e?.error }));
  if (raw.code === undefined && typeof e?.code === "string") raw.code = e.code;
  if (typeof e?.retryAfterMs === "number") raw.retryAfterMs = e.retryAfterMs;
  return raw;
}

/** Own-key lookup: names (provider, model id) are data, and `constructor` / `__proto__` must not find Object.prototype members. */
function own<V>(rec: Readonly<Record<string, V>> | undefined, key: string): V | undefined {
  return rec !== undefined && Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/**
 * A `{PLACEHOLDER}` in a base URL. One pattern for substitution and the leftover check, and a
 * superset of the names pi-ai itself fills from `process.env` (`[A-Z_][A-Z0-9_]*`), so an unfilled
 * one is refused here instead of being read from the environment behind `useEnv: false`.
 */
const PLACEHOLDER = /\{([A-Z0-9_]+)\}/g;
/** One provider's call: the model, its key, and provider options pi-ai reads (Azure URL, Bedrock region). */
type ChainCall = { model: Model<Api>; apiKey: string; extra?: Record<string, unknown> };

/** An AWS region name (`us-east-1`, `eu-central-2`, `us-gov-west-1`, `ap-southeast-5`). */
const AWS_REGION_NAME = /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}$/;
/** An Azure OpenAI resource name: letters, digits and hyphens. */
const AZURE_RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{1,62}$/;

/** A placeholder value goes into a URL path: plain id characters only, never `.` / `..` alone. */
const PLACEHOLDER_VALUE = /^(?!\.{1,2}$)[\w.-]+$/;

/**
 * A provider's own base URL in pi-ai's registry for models of `api` (one provider can serve
 * several APIs at different paths: Cloudflare's gateway has `/compat`, `/openai`, `/anthropic`).
 */
const registryBaseUrl = (provider: string, api: string): string | undefined => {
  try {
    const models = getModels(provider as never) as ReadonlyArray<Model<Api>>;
    return models.find((m) => m.api === api)?.baseUrl || undefined;
  } catch {
    return undefined;
  }
};

export function createProviderChain(options: ProviderChainOptions): ProviderChain {
  if (options.providers.length === 0) throw new Error("createProviderChain: no providers");
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  // Entries by name, and the names in chain order.
  const entries = new Map<string, ProviderEntry>();
  const names: string[] = [];
  for (const p of options.providers) {
    const entry: ProviderEntry = typeof p === "string" ? { name: p } : p;
    if (typeof entry.name !== "string" || entry.name === "")
      throw new Error("createProviderChain: a provider entry needs a name");
    if (entries.has(entry.name))
      throw new Error(`createProviderChain: provider "${entry.name}" is listed twice`);
    entries.set(entry.name, entry);
    names.push(entry.name);
  }
  /** The environment for an entry: none when `useEnv: false`. */
  const envFor = (entry: ProviderEntry): Readonly<Record<string, string | undefined>> =>
    entry.useEnv === false ? {} : env;
  const sleep = options.sleep ?? defaultSleep;
  const maxWait = options.maxRateLimitWaitMs ?? 10_000;
  const ACTIONS: ReadonlySet<string> = new Set(["stop", "next", "skip"]);
  for (const [cls, action] of Object.entries(options.actions ?? {})) {
    if (!Object.hasOwn(FAILOVER, cls))
      throw new Error(`createProviderChain: unknown failure class "${cls}" in actions`);
    if (!ACTIONS.has(action as string))
      throw new Error(
        `createProviderChain: action for "${cls}" must be "stop", "next" or "skip", not "${String(action)}"`,
      );
  }
  /** The rule for a class: the default table, unless `actions` overrides it. */
  const ruleFor = (cls: ProviderFailureClass): (typeof FAILOVER)[ProviderFailureClass] => {
    const action = own(options.actions, cls);
    const base = FAILOVER[cls];
    if (action === undefined) return base;
    if (action === "stop") return { failover: false };
    return {
      failover: true,
      ...(action === "skip" ? { bench: true as const } : {}),
      ...(base.retrySame ? { retrySame: true as const } : {}),
    };
  };

  const idFor = (provider: string, canonicalId: string): string | null => {
    const declared = own(entries.get(provider)?.models, canonicalId);
    if (declared !== undefined)
      return typeof declared === "string" ? declared : (declared?.id ?? null);
    const mapped = own(options.ids, canonicalId);
    if (mapped && Object.hasOwn(mapped, provider)) return mapped[provider] ?? null;
    return provider === "cloudflare-ai-gateway"
      ? canonicalId.replace(/^openai\//, "")
      : canonicalId;
  };

  /** The model for a provider and id: an entry declaration, `extraModels`, then pi-ai's registry. */
  const modelFor = (provider: string, canonicalId: string, id: string): Model<Api> | undefined => {
    const declared = own(entries.get(provider)?.models, canonicalId);
    if (declared !== null && typeof declared === "object")
      return {
        name: declared.id,
        api: "openai-completions",
        // Never "": an empty base URL makes the OpenAI SDK default to api.openai.com, which
        // would send this provider's credential there. The entry's, then the overrides', then
        // the provider's registry URL; `callFor` refuses if none is known.
        baseUrl:
          entries.get(provider)?.baseUrl ??
          own(options.overrides, provider)?.baseUrl ??
          // Bedrock's registry lists one URL per region; the region (or `baseUrl`) picks it.
          (provider === "amazon-bedrock"
            ? undefined
            : registryBaseUrl(provider, declared.api ?? "openai-completions")) ??
          "",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
        ...declared,
        provider,
      } as Model<Api>;
    return (
      options.extraModels?.find((m) => m.provider === provider && m.id === id) ??
      (getModel(provider as never, id as never) as Model<Api> | undefined)
    );
  };

  /** The call for one provider: pi-ai's own model entry (base URL, api, quirks) plus key; null if it cannot serve the id. */
  const callFor = (provider: string, canonicalId: string): ChainCall | string | null => {
    const id = idFor(provider, canonicalId);
    if (id === null) return null;
    const found = modelFor(provider, canonicalId, id);
    if (!found) return null;
    const entry = entries.get(provider) ?? { name: provider };
    const entryEnv = envFor(entry);
    const configured = entry.baseUrl ?? own(options.overrides, provider)?.baseUrl;
    // Options pi-ai reads for this provider, so its own process.env fallbacks cannot override
    // what the settings (or the entry's environment) chose.
    const extra: Record<string, unknown> = {};
    let fallbackUrl = found.baseUrl;
    if (provider === "amazon-bedrock") {
      const region = entry.region ?? entryEnv.AWS_REGION ?? entryEnv.AWS_DEFAULT_REGION;
      if (region !== undefined && !AWS_REGION_NAME.test(region))
        return `amazon-bedrock: not an AWS region name (set "region", e.g. "eu-west-1")`;
      if (region !== undefined) {
        extra.region = region;
        fallbackUrl = `https://bedrock-runtime.${region}.amazonaws.com`;
      } else if (configured === undefined && typeof own(entry.models, canonicalId) === "object")
        return `amazon-bedrock: a declared model needs "region" or "baseUrl"`;
    }
    if (provider === "azure-openai-responses" && configured === undefined && !found.baseUrl) {
      // pi-ai lists Azure models without a base URL and reads it from process.env; read it from
      // the entry's environment here instead (nothing with `useEnv: false`).
      const resource = entryEnv.AZURE_OPENAI_RESOURCE_NAME;
      const fromEnv = entryEnv.AZURE_OPENAI_BASE_URL?.trim();
      if (fromEnv) fallbackUrl = fromEnv;
      else if (resource !== undefined && AZURE_RESOURCE_NAME.test(resource))
        fallbackUrl = `https://${resource}.openai.azure.com/openai/v1`;
    }
    const baseUrl = (configured ?? fallbackUrl).replace(PLACEHOLDER, (_m, n: string) => {
      const v = own(entry.vars, n) ?? entryEnv[n];
      // An unusable value stays a placeholder and is refused below (the value is never echoed).
      return v !== undefined && PLACEHOLDER_VALUE.test(v) ? v : `{${n}}`;
    });
    const left = baseUrl.match(new RegExp(PLACEHOLDER.source));
    if (left)
      return `no usable value for ${left[0]} in the settings or environment (letters, digits, "_", "." and "-" only)`;
    if (baseUrl.trim() === "")
      return provider === "azure-openai-responses"
        ? `no base URL for provider "${provider}": set "baseUrl" (https://<resource>.openai.azure.com/openai/v1), or AZURE_OPENAI_BASE_URL / AZURE_OPENAI_RESOURCE_NAME in the environment`
        : `no base URL for provider "${provider}"`;
    if (provider === "azure-openai-responses") extra.azureBaseUrl = baseUrl;
    const apiKey = entry.apiKey ?? own(options.apiKeys, provider) ?? readApiKey(provider, entryEnv);
    if (!apiKey) return `no API key for provider "${provider}"`;
    const headers = {
      ...found.headers,
      ...own(options.overrides, provider)?.headers,
      ...entry.headers,
    };
    return {
      model: {
        ...found,
        ...own(options.overrides, provider),
        baseUrl,
        id,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
      apiKey,
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    };
  };

  const forRun = (listener?: ProviderFailoverListener): ChainStreamFn => {
    const benched = new Set<string>();
    const notify = (n: ProviderFailoverNotice): void => {
      try {
        listener?.(n);
      } catch {
        /* a trace hook must not break the call */
      }
    };

    return (canonical, context, callOptions) => {
      // A model whose provider is not in the chain (a compaction `summaryModel`,
      // a subagent's own model) is not the chain's to route: it goes straight to
      // pi-ai with the key the resolver gave it. No failover, no tap.
      if (!names.includes(canonical.provider)) return streamSimple(canonical, context, callOptions);
      const out = createAssistantMessageEventStream();
      const signal = callOptions?.signal;
      const end = (msg: AssistantMessage): void => {
        out.push({
          type: "error",
          reason: msg.stopReason === "aborted" ? "aborted" : "error",
          error: msg,
        });
        out.end();
      };

      /** The message as a caller abort: partial content kept, no provider text. */
      const abortedMessage = (msg: AssistantMessage): AssistantMessage => ({
        ...msg,
        stopReason: "aborted",
        errorMessage: "aborted",
      });

      /** A failure after content was delivered: the message keeps its partial content, the text is class-only. */
      const failedAfterContent = (msg: AssistantMessage, f: ProviderFailure): AssistantMessage => ({
        ...msg,
        stopReason: "error",
        errorMessage: describeFailure(f, options.includeProviderText === true),
        diagnostics: failureDiagnostics([f]),
      });

      /** One call to one provider. Events are held until the first content event, so a failure before it is retryable elsewhere. */
      const attempt = async (provider: string, call: ChainCall) => {
        // The response tap restores what pi-ai drops (status, body code, Retry-After) for the real
        // transport; a custom `streams` entry never touches fetch, so it is not tapped.
        const billed = options.billedCost === true && isOpenRouter(call.model);
        const tap = own(options.streams, provider)
          ? undefined
          : startAttemptTap(billed ? { cost: true } : {});
        try {
          return await attemptOnce(provider, call, tap, billed);
        } finally {
          tap?.dispose();
        }
      };
      const attemptOnce = async (
        provider: string,
        call: ChainCall,
        tap?: AttemptTap,
        billed = false,
      ): Promise<{ failure: ProviderFailure; message: AssistantMessage | null } | null> => {
        const failed = (raw: RawFailure, message: AssistantMessage | null = null) => {
          const seen = tap?.take();
          return {
            failure: classifyFailure(provider, seen ? rawFromResponse(seen, raw.message) : raw),
            message,
          };
        };
        const stream = own(options.streams, provider) ?? streamSimple;
        let inner: AssistantMessageEventStream;
        try {
          // The SDK's own retries are off: failing over is the retry.
          inner = await stream(call.model, context, {
            ...callOptions,
            ...call.extra,
            apiKey: call.apiKey,
            maxRetries: callOptions?.maxRetries ?? 0,
            ...(tap ? { headers: { ...callOptions?.headers, ...tap.header } } : {}),
            ...(billed && tap && Object.keys(tap.header).length > 0
              ? { onPayload: withUsageInclude(callOptions?.onPayload) }
              : {}),
          });
        } catch (err) {
          return failed(rawFromThrown(err));
        }
        const held: AssistantMessageEvent[] = [];
        let committed = false;
        const send = (ev: AssistantMessageEvent): void => {
          if (!committed) {
            committed = true;
            for (const h of held) out.push(h);
            held.length = 0;
          }
          out.push(ev);
        };
        try {
          for await (const ev of inner) {
            if (ev.type === "start" && !committed) held.push(ev);
            else if (ev.type === "error") {
              // A caller abort passes through unchanged. A failure after content was
              // delivered is not replayed elsewhere; its text is replaced like any other.
              if (ev.reason === "aborted") return (send(ev), out.end(), null);
              if (signal?.aborted) return (end(abortedMessage(ev.error)), null);
              if (committed) {
                const f = classifyFailure(provider, {
                  message: ev.error.errorMessage ?? "provider error",
                });
                return (end(failedAfterContent(ev.error, f)), null);
              }
              return failed({ message: ev.error.errorMessage ?? "provider error" }, ev.error);
            } else if (ev.type === "done") {
              const empty = ev.message.content.length === 0 && !ev.message.usage?.output;
              if (empty && !committed)
                return failed(
                  { message: "provider returned an empty completion (malformed response)" },
                  ev.message,
                );
              return (send(billed && tap ? await applyBilledCost(ev, tap) : ev), out.end(), null);
            } else send(ev);
          }
        } catch (err) {
          if (committed && signal?.aborted)
            return (end(abortedMessage(errorMessage(call.model, provider, ""))), null);
          if (committed)
            return (
              end(
                failedAfterContent(
                  errorMessage(call.model, provider, ""),
                  classifyFailure(provider, rawFromThrown(err)),
                ),
              ),
              null
            );
          return failed(rawFromThrown(err));
        }
        if (committed)
          return (
            end(
              errorMessage(call.model, provider, "provider stream ended without a final message"),
            ),
            null
          );
        return failed({
          message: "provider stream ended without a final message (malformed response)",
        });
      };

      void (async () => {
        const servable: Array<{ provider: string; call: ChainCall }> = [];
        const unusable: string[] = [];
        for (const provider of names) {
          const call = callFor(provider, canonical.id);
          if (call === null) continue;
          if (typeof call === "string") unusable.push(`${provider}: ${call}`);
          else servable.push({ provider, call });
        }
        if (servable.length === 0) {
          const why = unusable.length ? `: ${unusable.join("; ")}` : "";
          return end(
            errorMessage(
              canonical,
              names[0]!,
              `no provider can serve model "${canonical.id}"${why}`,
            ),
          );
        }
        // Providers that answered credits, key or region earlier in this run go last.
        const order = [
          ...servable.filter((s) => !benched.has(s.provider)),
          ...servable.filter((s) => benched.has(s.provider)),
        ];
        const failures: ProviderFailure[] = [];
        // The failures that benched their provider, for the chain record.
        const benchedBy = new Set<ProviderFailure>();
        let last: AssistantMessage | null = null;
        for (let i = 0; i < order.length; i++) {
          const { provider, call } = order[i]!;
          const next = order[i + 1]?.provider ?? null;
          let retried = false;
          for (;;) {
            if (signal?.aborted)
              return end(errorMessage(canonical, provider, "aborted", "aborted"));
            const res = await attempt(provider, call);
            if (res === null) return; // the stream is finished
            // A caller abort mid-attempt can surface as a transport error ("Connection
            // error."): it is a cancel, never a provider failure to classify or fail over on.
            if (signal?.aborted)
              return end(errorMessage(canonical, provider, "aborted", "aborted"));
            const f = res.failure;
            last = res.message ?? last;
            const rule = ruleFor(f.failureClass);
            const base = {
              from: provider,
              failureClass: f.failureClass,
              status: f.status,
              ...(f.code ? { code: f.code } : {}),
            };
            if (
              rule.retrySame &&
              !retried &&
              f.retryAfterMs !== undefined &&
              f.retryAfterMs <= maxWait
            ) {
              retried = true;
              notify({ ...base, action: "retry", to: null, waitMs: f.retryAfterMs });
              try {
                await sleep(f.retryAfterMs, signal);
              } catch {
                return end(errorMessage(canonical, provider, "aborted", "aborted"));
              }
              continue;
            }
            failures.push(f);
            if (rule.bench) {
              benched.add(provider);
              benchedBy.add(f);
            }
            const scope = { benched: rule.bench === true };
            if (rule.failover && next !== null) {
              notify({ ...base, ...scope, action: "failover", to: next });
              break;
            }
            notify({ ...base, ...scope, action: "exhausted", to: null });
            const show = (x: ProviderFailure): string =>
              describeFailure(x, options.includeProviderText === true);
            const text =
              failures.length === 1 && !rule.failover
                ? show(failures[0]!)
                : `all providers failed: ${failures.map(show).join(" | ")}`;
            return end({
              ...(last ?? errorMessage(canonical, provider, "")),
              stopReason: "error",
              errorMessage: text,
              diagnostics: failureDiagnostics(failures, benchedBy),
            });
          }
        }
      })();
      return out;
    };
  };

  const preResolvedModels = (): Map<string, PreResolvedModel> => {
    const map = new Map<string, PreResolvedModel>();
    for (const [name, id] of Object.entries(options.models ?? {})) {
      // The harness needs one model object for cost and context window: the first provider's registry entry, else a plain one.
      let model: Model<Api> | undefined;
      for (const p of names) {
        const pid = idFor(p, id);
        model = pid === null ? undefined : modelFor(p, id, pid);
        if (model) break;
      }
      model ??= {
        id,
        name: id,
        api: "openai-completions",
        provider: names[0]!,
        baseUrl: "",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      };
      map.set(name, {
        model: { ...model, id } as PreResolvedModel["model"],
        apiKey: "provider-chain",
      });
    }
    return map;
  };

  const balanceSources = (): ReadonlyArray<BalanceSource> =>
    names.flatMap((p) => {
      const b =
        options.balances && Object.hasOwn(options.balances, p) ? options.balances[p] : undefined;
      return b ? [b] : [];
    });

  return { providers: names, forRun, preResolvedModels, balanceSources };
}
