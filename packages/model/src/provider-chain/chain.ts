import type { ProviderFailureClass } from "@droveragent/core";
import {
  createAssistantMessageEventStream,
  getModel,
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

/** What the harness turns into a `provider_failover` event. */
export interface ProviderFailoverNotice {
  action: "retry" | "failover" | "exhausted";
  from: string;
  to: string | null;
  failureClass: ProviderFailureClass;
  status: number | null;
  code?: string;
  waitMs?: number;
}
export type ProviderFailoverListener = (notice: ProviderFailoverNotice) => void;

export interface ProviderChainOptions {
  /** pi-ai provider names, in order of preference: `["openrouter", "cloudflare-ai-gateway"]`. */
  providers: readonly string[];
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
  /** Put the providers' own text in the final error message. Off: it can quote the prompt. */
  includeProviderText?: boolean;
  /** Replace a provider's transport (tests, proxies), by provider name. */
  streams?: Readonly<Record<string, ChainStreamFn>>;
  /** Wait for a retry (tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ProviderChain {
  readonly providers: readonly string[];
  /** The transport for ONE run; failover notices go to `listener`. A provider benched in this run stays benched only in it. */
  forRun(listener?: ProviderFailoverListener): ChainStreamFn;
  /** `options.models` as harness `preResolvedModels`. The key is a placeholder: each call uses its provider's key. */
  preResolvedModels(): Map<string, PreResolvedModel>;
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
): NonNullable<AssistantMessage["diagnostics"]> {
  return failures.map((x) => ({
    type: "provider_failure",
    timestamp: Date.now(),
    details: {
      provider: x.provider,
      failureClass: x.failureClass,
      status: x.status,
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

export function createProviderChain(options: ProviderChainOptions): ProviderChain {
  if (options.providers.length === 0) throw new Error("createProviderChain: no providers");
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const sleep = options.sleep ?? defaultSleep;
  const maxWait = options.maxRateLimitWaitMs ?? 10_000;

  const idFor = (provider: string, canonicalId: string): string | null => {
    const mapped = own(options.ids, canonicalId);
    if (mapped && Object.hasOwn(mapped, provider)) return mapped[provider] ?? null;
    return provider === "cloudflare-ai-gateway"
      ? canonicalId.replace(/^openai\//, "")
      : canonicalId;
  };

  /** The call for one provider: pi-ai's own model entry (base URL, api, quirks) plus key; null if it cannot serve the id. */
  const callFor = (
    provider: string,
    canonicalId: string,
  ): { model: Model<Api>; apiKey: string } | string | null => {
    const id = idFor(provider, canonicalId);
    if (id === null) return null;
    const found =
      options.extraModels?.find((m) => m.provider === provider && m.id === id) ??
      (getModel(provider as never, id as never) as Model<Api> | undefined);
    if (!found) return null;
    const baseUrl = (own(options.overrides, provider)?.baseUrl ?? found.baseUrl).replace(
      /\{([A-Z_][A-Z0-9_]*)\}/g,
      (_m, n: string) => env[n] ?? `{${n}}`,
    );
    if (/\{[A-Z_]+\}/.test(baseUrl))
      return `no value for ${baseUrl.match(/\{[A-Z_]+\}/)![0]} in the environment`;
    const apiKey = own(options.apiKeys, provider) ?? readApiKey(provider, env);
    if (!apiKey) return `no API key for provider "${provider}"`;
    return { model: { ...found, ...own(options.overrides, provider), baseUrl, id }, apiKey };
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
      if (!options.providers.includes(canonical.provider))
        return streamSimple(canonical, context, callOptions);
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
      const attempt = async (provider: string, call: { model: Model<Api>; apiKey: string }) => {
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
        call: { model: Model<Api>; apiKey: string },
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
        const servable: Array<{ provider: string; call: { model: Model<Api>; apiKey: string } }> =
          [];
        const unusable: string[] = [];
        for (const provider of options.providers) {
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
              options.providers[0]!,
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
            const rule = FAILOVER[f.failureClass];
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
            if (rule.bench) benched.add(provider);
            if (rule.failover && next !== null) {
              notify({ ...base, action: "failover", to: next });
              break;
            }
            notify({ ...base, action: "exhausted", to: null });
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
              diagnostics: failureDiagnostics(failures),
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
      for (const p of options.providers) {
        const pid = idFor(p, id);
        model =
          pid === null
            ? undefined
            : (options.extraModels?.find((m) => m.provider === p && m.id === pid) ??
              (getModel(p as never, pid as never) as Model<Api> | undefined));
        if (model) break;
      }
      model ??= {
        id,
        name: id,
        api: "openai-completions",
        provider: options.providers[0]!,
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

  return { providers: options.providers, forRun, preResolvedModels };
}
