/**
 * A scripted fake provider for tests: a `streamFn` (also usable as a provider
 * chain `streams` entry) that answers each model call with the next step of a
 * script, including the failures real providers produce. No network.
 *
 *   const fake = fakeProvider([faults.credits(), reply.text("done")]);
 *   runAgentEffect({ ...args, deps: { ...deps, streamFn: fake.streamFn } }); // no chain
 *   createProviderChain({ providers: ["openrouter", "x"], streams: { openrouter: fake.streamFn, ... } });
 *
 * Failures are pi-shaped by default: an `error` event whose `errorMessage` is
 * `"<status> <text>"`, exactly what pi-ai produces over the real transport
 * (no response body, no headers), so the harness ends the run `ProviderError`
 * and a chain classifies from the leading status. `structured: true` THROWS an
 * error carrying `status`, `error.code` and `retryAfterMs` instead, which is
 * what a provider chain reads from a custom transport (a region refusal is then
 * `region_refused`, not a bare-403 `forbidden`). A thrown error outside a chain
 * fails the loop (`LoopError`), so use `structured` only under a chain.
 */
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

type StreamArgs = Parameters<StreamFn>;

/** One scripted answer. */
export type FakeStep =
  | { kind: "text"; text: string; usage?: { input: number; output: number; cost?: number } }
  | {
      kind: "toolCall";
      name: string;
      arguments: Record<string, unknown>;
      id?: string;
      usage?: { input: number; output: number; cost?: number };
    }
  | {
      kind: "http";
      status: number;
      /** Provider text after the status (default: a short reason phrase). */
      message?: string;
      /** Structured error code (`structured` mode only), e.g. `unsupported_country_region_territory`. */
      code?: string;
      /** `Retry-After` in ms: a structured field, or a `Retry-After: N` hint in the text on a 429. */
      retryAfterMs?: number;
      /** Throw a structured error (for a provider chain) instead of a pi-shaped error event. */
      structured?: boolean;
    }
  | { kind: "timeout" }
  | { kind: "empty" };

/** Ready-made failure steps (the kinds real providers produce). */
export const faults = {
  /** 402 out of credits. */
  credits: (opts: { structured?: boolean } = {}): FakeStep => ({
    kind: "http",
    status: 402,
    message: "This request requires more credits",
    ...opts,
  }),
  /** 403; with `region`, a region refusal (`unsupported_country_region_territory`, structured mode). */
  forbidden: (opts: { region?: boolean; structured?: boolean } = {}): FakeStep => ({
    kind: "http",
    status: 403,
    message: opts.region ? "Country, region, or territory not supported" : "Forbidden",
    ...(opts.region ? { code: "unsupported_country_region_territory" } : {}),
    ...(opts.structured ? { structured: true } : {}),
  }),
  /** 429 with a `Retry-After` of `seconds`. */
  rateLimited: (seconds = 1, opts: { structured?: boolean } = {}): FakeStep => ({
    kind: "http",
    status: 429,
    message: "Rate limit reached",
    retryAfterMs: seconds * 1000,
    ...opts,
  }),
  /** A 5xx (default 503). */
  serverError: (status = 503, opts: { structured?: boolean } = {}): FakeStep => ({
    kind: "http",
    status,
    message: "Service unavailable",
    ...opts,
  }),
  /** The SDK's timeout (no status). */
  timeout: (): FakeStep => ({ kind: "timeout" }),
  /** A stream that ends with no content and zero usage. */
  empty: (): FakeStep => ({ kind: "empty" }),
};

/** Ready-made successful steps. */
export const reply = {
  text: (text: string, usage?: { input: number; output: number; cost?: number }): FakeStep => ({
    kind: "text",
    text,
    ...(usage ? { usage } : {}),
  }),
  toolCall: (
    name: string,
    args: Record<string, unknown> = {},
    usage?: { input: number; output: number; cost?: number },
  ): FakeStep => ({ kind: "toolCall", name, arguments: args, ...(usage ? { usage } : {}) }),
};

/** Thrown when the script has no step left for a call. */
export class FakeProviderExhaustedError extends Error {
  readonly _tag = "FakeProviderExhaustedError";
  constructor(readonly call: number) {
    super(`fake provider: no scripted step for call ${call}`);
  }
}

export interface FakeProvider {
  streamFn: StreamFn;
  /** Every call made, in order: the model and request context it received. */
  calls: Array<{ model: StreamArgs[0]; context: StreamArgs[1] }>;
}

const usageOf = (u?: { input: number; output: number; cost?: number }) => ({
  input: u?.input ?? 0,
  output: u?.output ?? 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: (u?.input ?? 0) + (u?.output ?? 0),
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u?.cost ?? 0 },
});

/**
 * A fake provider that answers call N with `script[N]`. Deterministic: tool-call
 * ids are `call_<N>` unless given, timestamps are fixed. Calls past the end throw
 * {@link FakeProviderExhaustedError} (or repeat the last step with `repeatLast`).
 */
export function fakeProvider(
  script: readonly FakeStep[],
  opts: { repeatLast?: boolean } = {},
): FakeProvider {
  const calls: FakeProvider["calls"] = [];
  const streamFn: StreamFn = (model, context, options) => {
    const n = calls.length;
    calls.push({ model, context });
    const step = script[n] ?? (opts.repeatLast ? script.at(-1) : undefined);
    if (!step) throw new FakeProviderExhaustedError(n);
    const base = (over: Partial<AssistantMessage>): AssistantMessage => ({
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: usageOf(),
      stopReason: "stop",
      timestamp: 0,
      ...over,
    });
    const out = createAssistantMessageEventStream();
    const finish = (events: AssistantMessageEvent[]): typeof out => {
      for (const e of events) out.push(e);
      out.end();
      return out;
    };
    if (options?.signal?.aborted)
      return finish([
        {
          type: "error",
          reason: "aborted",
          error: base({ stopReason: "aborted", errorMessage: "Request was aborted" }),
        },
      ]);
    switch (step.kind) {
      case "text": {
        const m = base({
          content: [{ type: "text", text: step.text }],
          usage: usageOf(step.usage),
        });
        return finish([
          { type: "start", partial: m },
          { type: "done", reason: "stop", message: m },
        ]);
      }
      case "toolCall": {
        const m = base({
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: step.id ?? `call_${n}`,
              name: step.name,
              arguments: step.arguments,
            },
          ],
          usage: usageOf(step.usage),
        });
        return finish([
          { type: "start", partial: m },
          { type: "done", reason: "toolUse", message: m },
        ]);
      }
      case "empty": {
        const m = base({});
        return finish([
          { type: "start", partial: m },
          { type: "done", reason: "stop", message: m },
        ]);
      }
      case "timeout":
        return finish([
          {
            type: "error",
            reason: "error",
            error: base({ stopReason: "error", errorMessage: "Request timed out." }),
          },
        ]);
      case "http": {
        const hint =
          step.status === 429 && step.retryAfterMs !== undefined && !step.structured
            ? ` Retry-After: ${Math.round(step.retryAfterMs / 1000)}`
            : "";
        const text = `${step.status} ${step.message ?? "error"}${hint}`;
        if (step.structured) {
          throw Object.assign(new Error(text), {
            status: step.status,
            ...(step.code ? { error: { code: step.code } } : {}),
            ...(step.retryAfterMs !== undefined ? { retryAfterMs: step.retryAfterMs } : {}),
          });
        }
        return finish([
          {
            type: "error",
            reason: "error",
            error: base({ stopReason: "error", errorMessage: text }),
          },
        ]);
      }
    }
  };
  return { streamFn, calls };
}
