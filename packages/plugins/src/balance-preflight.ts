import type { HarnessPlugin, ModelCallDecision } from "@droveragent/core";
import { Effect } from "effect";

/** A provider's own balance lookup. Host-level: nothing in the provider chain depends on it. */
export interface BalanceSource {
  /** For messages. */
  provider: string;
  /** Remaining spendable USD. May throw or reject: that is "unknown". */
  balance(signal?: AbortSignal): Promise<{ remainingUsd: number }>;
}

export interface OpenRouterBalanceOptions {
  apiKey: string;
  /** Default `https://openrouter.ai/api/v1`. */
  baseUrl?: string;
  /** Replace `fetch` (tests, proxies). Default: the global one. */
  fetch?: typeof fetch;
}

/**
 * OpenRouter's account balance: `GET <base>/credits` -> `{ data: { total_credits, total_usage } }`,
 * remaining = credits - usage. Written from OpenRouter's documented response shape; not verified
 * against the live API. Pass the key explicitly: nothing here reads the environment.
 */
export function openRouterBalance(opts: OpenRouterBalanceOptions): BalanceSource {
  const base = (opts.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  return {
    provider: "openrouter",
    async balance(signal) {
      const res = await (opts.fetch ?? fetch)(`${base}/credits`, {
        headers: { authorization: `Bearer ${opts.apiKey}` },
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`balance lookup failed: ${res.status}`);
      const body = (await res.json()) as {
        data?: { total_credits?: unknown; total_usage?: unknown };
      };
      const credits = body.data?.total_credits;
      const used = body.data?.total_usage;
      if (typeof credits !== "number" || typeof used !== "number")
        throw new Error("balance lookup: unexpected shape");
      return { remainingUsd: credits - used };
    },
  };
}

export interface BalancePreflightOptions {
  /** Looked up in order; the first that answers is used. */
  sources: ReadonlyArray<BalanceSource>;
  /** What the run is expected to cost, USD, or a function of the run. */
  estimateUsd: number | ((ctx: { runId: string }) => number);
  /** Always keep this much unspent (USD). Default 0. */
  reserveUsd?: number;
  /**
   * Also check before every Nth model call (the 1st always is), against what is still expected to be spent
   * (estimate minus spent so far, never below 0). Default 0: only before the run.
   */
  everyNCalls?: number;
  /** Give up on a lookup after this long, ms. Default 3000. */
  lookupTimeoutMs?: number;
  /** Reuse a lookup this long, ms. Default 5000. */
  cacheMs?: number;
  /**
   * When every source fails or times out: `allow` (default; the check is advisory) or `refuse` (strict). The
   * failure reason is never put in the run's error message.
   */
  onUnknown?: "allow" | "refuse";
  /** Clock (tests). */
  now?: () => number;
}

/**
 * Admission control before a run (and optionally every N calls): refuse with a clear error when a provider's
 * balance is below the estimate plus a reserve, instead of failing mid-run with a 402. Uses the harness's
 * `beforeModelCall` hook; the run ends `status: "error"`, tag `InsufficientBalance`, with no model call made.
 */
export function balancePreflightPlugin(opts: BalancePreflightOptions): HarnessPlugin {
  const reserve = opts.reserveUsd ?? 0;
  const every = opts.everyNCalls ?? 0;
  const timeoutMs = opts.lookupTimeoutMs ?? 3000;
  const cacheMs = opts.cacheMs ?? 5000;
  const now = opts.now ?? Date.now;
  let cached: { at: number; remainingUsd: number; provider: string } | null = null;

  const lookup = async (): Promise<{ remainingUsd: number; provider: string } | null> => {
    if (cached && now() - cached.at < cacheMs) return cached;
    for (const source of opts.sources) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const { remainingUsd } = await Promise.race([
          source.balance(ac.signal),
          new Promise<never>((_, reject) =>
            ac.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }),
          ),
        ]);
        if (Number.isFinite(remainingUsd)) {
          cached = { at: now(), remainingUsd, provider: source.provider };
          return cached;
        }
      } catch {
        /* try the next source */
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  };

  return {
    id: "balance-preflight",
    beforeModelCall: (info, ctx) =>
      Effect.promise(async (): Promise<ModelCallDecision> => {
        const due = info.callNumber === 1 || (every > 0 && info.callNumber % every === 0);
        if (!due) return { kind: "allow" };
        const strictUnknown = (what: string): ModelCallDecision =>
          opts.onUnknown === "refuse"
            ? {
                kind: "refuse",
                tag: "BalanceUnknown",
                message: `${what} and the preflight is strict`,
              }
            : { kind: "allow" };
        // A throwing or non-finite estimate is "unknown", like an unreadable balance: it must
        // not slip through when the host asked for a strict preflight.
        let estimate: number;
        try {
          estimate =
            typeof opts.estimateUsd === "function"
              ? opts.estimateUsd({ runId: ctx.runId })
              : opts.estimateUsd;
        } catch {
          return strictUnknown("the run's cost estimate could not be computed");
        }
        if (!Number.isFinite(estimate)) {
          return strictUnknown("the run's cost estimate is not a finite number");
        }
        const spent = info.callNumber === 1 ? 0 : (info.usage.costUsd ?? 0);
        const stillExpected = Math.max(0, estimate - spent);
        const needed = stillExpected + reserve;
        const seen = await lookup();
        if (!seen) return strictUnknown("provider balance could not be read");
        if (seen.remainingUsd >= needed) return { kind: "allow" };
        const usd = (n: number): string => `$${n.toFixed(2)}`;
        const basis =
          info.callNumber === 1
            ? `estimate ${usd(estimate)} plus reserve ${usd(reserve)}`
            : `estimate ${usd(estimate)} minus ${usd(spent)} already spent leaves ${usd(stillExpected)}, plus reserve ${usd(reserve)}`;
        return {
          kind: "refuse",
          tag: "InsufficientBalance",
          message: `${seen.provider} balance ${usd(seen.remainingUsd)} is below the ${usd(needed)} needed (${basis})`,
        };
      }),
  };
}
