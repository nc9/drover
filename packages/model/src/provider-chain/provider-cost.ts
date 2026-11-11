/**
 * Provider-billed cost.
 *
 * pi-ai (`openai-completions`) prices a call from the model's list rates
 * (`Model.cost`) and DROPS the provider's own `usage.cost`. For OpenRouter that
 * field is the amount actually billed (routing, discounts, cache pricing and BYOK
 * folded in), sent only when the request carries `usage: { include: true }`.
 *
 * `withProviderCost(base)` (a `streamFn`) and the provider chain's `billedCost`
 * option read it through the shared per-attempt response tap
 * (`response-tap.ts`): add `usage: { include: true }` to the body, tag the
 * request, read `usage.cost` from a teed copy of the 2xx body, and on `done`
 * REPLACE `message.usage.cost.total` with the billed figure (never added to the
 * list-price figure, so nothing is counted twice). The per-component fields
 * (`cost.input`, ...) stay list-price. No billed cost arriving: unchanged.
 *
 * OpenRouter only (by provider name, or a base URL on `openrouter.ai`). Every
 * other model goes to `base` untouched: no body key, no header, no tap.
 */
import {
  createAssistantMessageEventStream,
  streamSimple,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";

import type { ChainStreamFn as StreamFn } from "./chain.ts";
import { startAttemptTap, type AttemptTap } from "./response-tap.ts";

/** OpenRouter is the provider that reports `usage.cost`. */
export const isOpenRouter = (model: { provider?: string; baseUrl?: string }): boolean => {
  if (model.provider === "openrouter") return true;
  // The base URL's parsed host, not a substring: `https://evil.test/openrouter.ai` or
  // `https://openrouter.ai.evil.test` is not OpenRouter.
  try {
    const host = new URL(model.baseUrl ?? "").hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
};

/** Compose a caller `onPayload` with `usage: { include: true }`. */
export const withUsageInclude = (
  callerPayload: SimpleStreamOptions["onPayload"],
): NonNullable<SimpleStreamOptions["onPayload"]> => {
  return async (payload, model) => {
    const patched = (await callerPayload?.(payload, model)) ?? payload;
    const body = patched as Record<string, unknown>;
    const prior = body.usage as Record<string, unknown> | undefined;
    return { ...body, usage: { ...prior, include: true } };
  };
};

/** The `done` message with `usage.cost.total` replaced by the billed cost, when one arrived. */
export const applyBilledCost = async (
  ev: AssistantMessageEvent & { type: "done" },
  tap: AttemptTap,
): Promise<AssistantMessageEvent> => {
  const billed = await tap.cost();
  if (billed === undefined) return ev;
  const usage = ev.message.usage;
  return {
    ...ev,
    message: { ...ev.message, usage: { ...usage, cost: { ...usage.cost, total: billed } } },
  };
};

/**
 * Wrap `base` (default: pi's `streamSimple`) so `Usage.costUsd` is the provider-billed
 * cost for OpenRouter calls. Pass the result as `streamFn`. Under a provider chain
 * use the chain's `billedCost` option instead (the chain does not use `streamFn`).
 */
export const withProviderCost = (base: StreamFn = streamSimple as StreamFn): StreamFn => {
  return async (model, context, options) => {
    if (!isOpenRouter(model)) return base(model, context, options);
    const tap = startAttemptTap({ cost: true });
    if (Object.keys(tap.header).length === 0) return base(model, context, options); // tap off
    let stream: AssistantMessageEventStream;
    try {
      stream = await base(model, context, {
        ...options,
        headers: { ...options?.headers, ...tap.header },
        onPayload: withUsageInclude(options?.onPayload),
      });
    } catch (err) {
      tap.dispose(); // the request never started: no pending state
      throw err;
    }
    const out = createAssistantMessageEventStream();
    void (async () => {
      try {
        for await (const e of stream) {
          out.push(e.type === "done" ? await applyBilledCost(e, tap) : e);
        }
      } finally {
        tap.dispose();
        out.end();
      }
    })();
    return out;
  };
};
