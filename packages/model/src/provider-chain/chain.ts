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

import type { PreResolvedModel } from "../resolve.ts";
import {
  DEFAULT_FAILOVER_POLICY,
  classifyFailure,
  structuredFromBody,
  type FailoverPolicyEntry,
  type ProviderFailure,
  type RawFailure,
} from "./classify.ts";

/** The `StreamFn` shape pi-agent-core calls for every model call. */
export type ChainStreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** What a provider adapter hands the chain for one call. */
export interface PreparedCall {
  /** The pi-ai model to call: `api`, `baseUrl`, `provider`, `id` as THIS provider wants them. */
  model: Model<Api>;
  apiKey: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

/**
 * One provider in a chain. Small by design: a name, a model id mapping and a
 * way to build the pi-ai model + credentials. Everything else (classifying
 * failures, retrying, failing over, cooldowns) is the chain's.
 */
export interface ProviderSpec {
  /** Stable name: trace events, `usageByProvider` and the `provider` of the model it calls. */
  name: string;
  /**
   * The id this provider serves for a canonical model id, or `null` when it
   * cannot serve that model. A provider that cannot serve the model is skipped
   * without counting as a failure.
   */
  mapModel(canonicalId: string): string | null;
  /** Build the model and credentials for a call to `mappedId`. */
  prepare(canonical: Model<Api>, mappedId: string): PreparedCall;
  /** Replace the transport (tests, proxies). Defaults to pi-ai's `streamSimple`. */
  stream?: ChainStreamFn;
}

/** Event delivered to a run's listener: what the harness turns into `provider_failover`. */
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

/** A model the chain serves, keyed by the spec's model name. */
export interface ChainModelDef {
  /** Canonical model id (OpenRouter style, `openai/gpt-5-mini`). Defaults to the key. */
  id?: string;
  /** Overrides on the canonical pi-ai model: cost, contextWindow, maxTokens, reasoning, input. */
  overrides?: Partial<Omit<Model<Api>, "id" | "api" | "baseUrl" | "provider">>;
}

export interface ProviderChainOptions {
  /** Ordered: the first is tried first. */
  providers: readonly ProviderSpec[];
  /** Models agents may name; see {@link ProviderChain.preResolvedModels}. */
  models?: Readonly<Record<string, ChainModelDef>>;
  /** Per-class overrides of {@link DEFAULT_FAILOVER_POLICY}. */
  policy?: Partial<Record<ProviderFailureClass, Partial<FailoverPolicyEntry>>>;
  /**
   * Longest `Retry-After` (ms) the chain waits out before retrying the same
   * provider. A longer ask fails over at once. Default 10 000.
   */
  maxRateLimitWaitMs?: number;
  /** Same-provider retries per call after a rate limit. Default 1. */
  maxSameProviderRetries?: number;
  /**
   * Fail an attempt that has produced no content event within this many ms (a
   * hung provider), as class `timeout`. Off by default.
   */
  firstEventTimeoutMs?: number;
  /**
   * The OpenAI SDK's own retries per attempt (it retries 408/409/429/5xx with
   * backoff and honours `Retry-After`). Default 0: failing over is the
   * retry, and the SDK's backoff would delay it by seconds. A caller's
   * `maxRetries` option still wins.
   */
  transportRetries?: number;
  /** Clock for cooldowns (tests). */
  now?: () => number;
  /** Wait for retries (tests). Must reject with an AbortError-like when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ProviderChain {
  /** Provider names in order. */
  readonly providers: readonly string[];
  /**
   * The transport for ONE run: pi's `StreamFn`, with failover notices going to
   * `listener`. Cooldown state belongs to the binding, so it lives and dies
   * with the run: nothing learned from one run's errors affects another.
   */
  forRun(listener?: ProviderFailoverListener): ChainStreamFn;
  /**
   * Models for the harness's `preResolvedModels`: the chain's models by spec
   * name. Their `apiKey` is a placeholder; each provider call uses that
   * provider's own credentials.
   */
  preResolvedModels(): Map<string, PreResolvedModel>;
}

const DEFAULT_MAX_WAIT_MS = 10_000;
const DEFAULT_RETRIES = 1;

/** The chain's own failure, surfaced as the final assistant error message. */
function describe(f: ProviderFailure): string {
  const parts = [f.failureClass];
  const detail = [f.status !== null ? String(f.status) : null, f.code ?? null].filter(Boolean);
  const head = detail.length ? `${parts[0]} (${detail.join(" ")})` : parts[0]!;
  return f.message ? `${f.provider}: ${head}: ${f.message}` : `${f.provider}: ${head}`;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Events that carry no model content: they do not commit an attempt to its provider. */
function isContentEvent(ev: AssistantMessageEvent): boolean {
  return ev.type !== "start";
}

function emptyMessage(model: Model<Api>, provider: string, errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}

/** Structured hints a thrown transport error may carry (SDK errors, custom fetchers). */
function rawFromThrown(err: unknown): RawFailure {
  const e = err as {
    message?: unknown;
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    retryAfterMs?: unknown;
    headers?: unknown;
    error?: unknown;
    body?: unknown;
  } | null;
  const raw: RawFailure = { message: typeof e?.message === "string" ? e.message : String(err) };
  const status = typeof e?.status === "number" ? e.status : e?.statusCode;
  if (typeof status === "number") raw.status = status;
  Object.assign(
    raw,
    structuredFromBody({ error: e?.error ?? (e?.body as { error?: unknown })?.error }),
  );
  if (raw.code === undefined && typeof e?.code === "string") raw.code = e.code;
  if (typeof e?.retryAfterMs === "number") raw.retryAfterMs = e.retryAfterMs;
  const h = e?.headers as Record<string, unknown> | undefined;
  const ra = h && typeof h === "object" ? h["retry-after"] : undefined;
  if (raw.retryAfterMs === undefined && ra !== undefined) {
    const n = Number(ra);
    if (Number.isFinite(n)) raw.retryAfterMs = Math.round(n * 1000);
  }
  return raw;
}

type AttemptResult =
  | { kind: "done" }
  | { kind: "failed"; failure: ProviderFailure; message: AssistantMessage | null };

export function createProviderChain(options: ProviderChainOptions): ProviderChain {
  if (options.providers.length === 0) throw new Error("createProviderChain: no providers");
  const names = new Set<string>();
  for (const p of options.providers) {
    if (names.has(p.name)) throw new Error(`createProviderChain: duplicate provider "${p.name}"`);
    names.add(p.name);
  }
  const policy = (cls: ProviderFailureClass): FailoverPolicyEntry =>
    ({ ...DEFAULT_FAILOVER_POLICY[cls], ...options.policy?.[cls] }) as FailoverPolicyEntry;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const maxWait = options.maxRateLimitWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const maxRetries = options.maxSameProviderRetries ?? DEFAULT_RETRIES;

  const forRun = (listener?: ProviderFailoverListener): ChainStreamFn => {
    /**
     * provider -> why it is skipped for the rest of THIS run, and until when.
     * One binding is one run: what one run's errors teach never reaches
     * another run or tenant.
     */
    const cooldowns = new Map<string, { until: number; failure: ProviderFailure }>();
    const notify = (n: ProviderFailoverNotice): void => {
      try {
        listener?.(n);
      } catch {
        // A trace hook must not break the call.
      }
    };

    return (canonical, context, callOptions) => {
      const out = createAssistantMessageEventStream();
      void (async () => {
        const signal = callOptions?.signal;
        const failures: ProviderFailure[] = [];

        // Providers that can serve this model; recently failed ones go last.
        const servable = options.providers
          .map((p) => ({ p, mapped: p.mapModel(canonical.id) }))
          .filter((x): x is { p: ProviderSpec; mapped: string } => x.mapped !== null);
        if (servable.length === 0) {
          finishError(
            out,
            emptyMessage(
              canonical,
              options.providers[0]!.name,
              `no provider serves model "${canonical.id}"`,
            ),
          );
          return;
        }
        const t = now();
        const live = servable.filter((x) => (cooldowns.get(x.p.name)?.until ?? 0) <= t);
        const cooled = servable.filter((x) => (cooldowns.get(x.p.name)?.until ?? 0) > t);
        const order = [...live, ...cooled];
        // A bypassed provider still shows in the trace, with the failure that benched it.
        for (const x of cooled) {
          const first = order.find((o) => !cooled.includes(o));
          const f = cooldowns.get(x.p.name)!.failure;
          if (first) {
            notify({
              action: "failover",
              from: x.p.name,
              to: first.p.name,
              failureClass: f.failureClass,
              status: f.status,
              ...(f.code ? { code: f.code } : {}),
            });
          }
        }

        let lastMessage: AssistantMessage | null = null;
        for (let i = 0; i < order.length; i++) {
          const { p, mapped } = order[i]!;
          const next = order[i + 1]?.p.name ?? null;
          let retries = 0;
          for (;;) {
            if (signal?.aborted) {
              finishError(
                out,
                { ...emptyMessage(canonical, p.name, "aborted"), stopReason: "aborted" },
                "aborted",
              );
              return;
            }
            const res = await attempt(p, mapped, canonical, context, callOptions, out);
            if (res.kind === "done") return;
            const f = res.failure;
            if (res.message) lastMessage = res.message;
            const entry = policy(f.failureClass);
            const wait = f.retryAfterMs;
            if (entry.retrySame && retries < maxRetries && wait !== undefined && wait <= maxWait) {
              retries++;
              notify({
                action: "retry",
                from: p.name,
                to: null,
                failureClass: f.failureClass,
                status: f.status,
                ...(f.code ? { code: f.code } : {}),
                waitMs: wait,
              });
              try {
                await sleep(wait, signal);
              } catch {
                finishError(
                  out,
                  { ...emptyMessage(canonical, p.name, "aborted"), stopReason: "aborted" },
                  "aborted",
                );
                return;
              }
              continue;
            }
            failures.push(f);
            if (entry.cooldownMs > 0) {
              cooldowns.set(p.name, { until: now() + entry.cooldownMs, failure: f });
            }
            if (entry.failover && next !== null) {
              notify({
                action: "failover",
                from: p.name,
                to: next,
                failureClass: f.failureClass,
                status: f.status,
                ...(f.code ? { code: f.code } : {}),
              });
              break;
            }
            // Chain over: no provider left, or this class does not fail over.
            notify({
              action: "exhausted",
              from: p.name,
              to: null,
              failureClass: f.failureClass,
              status: f.status,
              ...(f.code ? { code: f.code } : {}),
            });
            const base = lastMessage ?? emptyMessage(canonical, p.name, "");
            const text =
              failures.length === 1 && !entry.failover
                ? failures[0]!.message || describe(failures[0]!)
                : `all providers failed: ${failures.map(describe).join(" | ")}`;
            finishError(out, { ...base, stopReason: "error", errorMessage: text });
            return;
          }
        }
      })();
      return out;
    };
  };

  /** One call to one provider. Forwards to `out` once committed; otherwise reports the failure. */
  async function attempt(
    p: ProviderSpec,
    mapped: string,
    canonical: Model<Api>,
    context: Context,
    callOptions: SimpleStreamOptions | undefined,
    out: AssistantMessageEventStream,
  ): Promise<AttemptResult> {
    const fail = (raw: RawFailure, message: AssistantMessage | null = null): AttemptResult => ({
      kind: "failed",
      failure: classifyFailure(p.name, raw),
      message,
    });

    const ac = new AbortController();
    const parent = callOptions?.signal;
    const onParentAbort = (): void => ac.abort();
    parent?.addEventListener("abort", onParentAbort, { once: true });
    if (parent?.aborted) ac.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      let prepared: PreparedCall;
      try {
        prepared = p.prepare(canonical, mapped);
      } catch (err) {
        return fail({ message: `could not prepare call: ${(err as Error).message}` });
      }
      const headers = { ...callOptions?.headers, ...prepared.headers };
      const opts: SimpleStreamOptions = {
        ...callOptions,
        apiKey: prepared.apiKey,
        signal: ac.signal,
        maxRetries: callOptions?.maxRetries ?? options.transportRetries ?? 0,
        ...(Object.keys(headers).length ? { headers } : {}),
      };

      let inner: AssistantMessageEventStream;
      try {
        inner = await (p.stream ?? streamSimple)(prepared.model, context, opts);
      } catch (err) {
        return fail(rawFromThrown(err));
      }

      const buffer: AssistantMessageEvent[] = [];
      let committed = false;
      const commit = (): void => {
        committed = true;
        for (const ev of buffer) out.push(ev);
        buffer.length = 0;
      };
      const timeoutMs = options.firstEventTimeoutMs;
      const iterator = inner[Symbol.asyncIterator]();
      let timedOut = false;
      for (;;) {
        let step: IteratorResult<AssistantMessageEvent>;
        try {
          if (!committed && (timeoutMs !== undefined || parent)) {
            step = await Promise.race([
              iterator.next(),
              new Promise<never>((_, reject) => {
                if (timeoutMs !== undefined) {
                  timer = setTimeout(() => {
                    timedOut = true;
                    ac.abort();
                    reject(new Error("timed out waiting for the first event"));
                  }, timeoutMs);
                }
                // A caller abort must not wait for a silent provider.
                if (parent?.aborted) reject(new Error("aborted"));
                else
                  parent?.addEventListener("abort", () => reject(new Error("aborted")), {
                    once: true,
                  });
              }),
            ]);
            clearTimeout(timer);
          } else {
            step = await iterator.next();
          }
        } catch (err) {
          clearTimeout(timer);
          if (parent?.aborted) {
            out.push({
              type: "error",
              reason: "aborted",
              error: { ...emptyMessage(canonical, p.name, "aborted"), stopReason: "aborted" },
            });
            out.end();
            return { kind: "done" };
          }
          if (committed) {
            // Mid-stream after content went out: cannot be replayed on another provider.
            out.push({
              type: "error",
              reason: parent?.aborted ? "aborted" : "error",
              error: emptyMessage(canonical, p.name, (err as Error).message),
            });
            out.end();
            return { kind: "done" };
          }
          return fail(
            timedOut ? { message: "request timed out", status: null } : rawFromThrown(err),
          );
        }
        if (step.done) break;
        const ev = step.value;

        if (ev.type === "error") {
          if (ev.reason === "aborted" || committed) {
            // A caller abort, or a failure after content was delivered: pass it on.
            commit();
            out.push(ev);
            out.end();
            return { kind: "done" };
          }
          return fail({ message: ev.error.errorMessage ?? "provider error" }, ev.error);
        }
        if (ev.type === "done") {
          const m = ev.message;
          const empty = m.content.length === 0 && !m.usage?.output;
          if (empty && !committed) {
            return fail(
              { message: "provider returned an empty completion (malformed response)" },
              m,
            );
          }
          commit();
          out.push(ev);
          out.end();
          return { kind: "done" };
        }
        if (committed) out.push(ev);
        else if (isContentEvent(ev)) {
          buffer.push(ev);
          commit();
        } else buffer.push(ev);
      }
      // The stream ended without a terminal event.
      if (committed) {
        out.push({
          type: "error",
          reason: "error",
          error: emptyMessage(canonical, p.name, "provider stream ended without a final message"),
        });
        out.end();
        return { kind: "done" };
      }
      return fail({
        message: "provider stream ended without a final message (malformed response)",
      });
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    }
  }

  const preResolved = (): Map<string, PreResolvedModel> => {
    const map = new Map<string, PreResolvedModel>();
    for (const [name, def] of Object.entries(options.models ?? {})) {
      map.set(name, {
        model: canonicalModel(def.id ?? name, def.overrides) as PreResolvedModel["model"],
        apiKey: "provider-chain",
      });
    }
    return map;
  };

  return {
    providers: options.providers.map((p) => p.name),
    forRun,
    preResolvedModels: preResolved,
  };
}

function finishError(
  out: AssistantMessageEventStream,
  message: AssistantMessage,
  reason: "error" | "aborted" = "error",
): void {
  out.push({ type: "error", reason, error: { ...message, stopReason: reason } });
  out.end();
}

/**
 * The pi-ai model the chain hands the harness for a canonical id: pi's own
 * OpenRouter entry when it knows the id (cost, context window, reasoning),
 * else a plain text model with generous limits. `overrides` win either way.
 */
export function canonicalModel(id: string, overrides: ChainModelDef["overrides"] = {}): Model<Api> {
  let known: Model<Api> | undefined;
  try {
    known = getModel("openrouter" as never, id as never) as Model<Api> | undefined;
  } catch {
    known = undefined;
  }
  const base: Model<Api> = known ?? {
    id,
    name: id,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  return { ...base, ...overrides, id };
}
