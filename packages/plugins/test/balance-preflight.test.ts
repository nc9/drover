import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { RunContext } from "@droveragent/core";

import { balancePreflightPlugin, openRouterBalance, type BalanceSource } from "../src/index.ts";

const ctx: RunContext = {
  runId: "r",
  depth: 0,
  cwd: "/tmp",
  env: {},
  signal: new AbortController().signal,
};
const src = (
  provider: string,
  remainingUsd: number,
  calls: { n: number } = { n: 0 },
): BalanceSource => ({
  provider,
  balance: async () => (calls.n++, { remainingUsd }),
});
const failing = (provider: string): BalanceSource => ({
  provider,
  balance: async () => Promise.reject(new Error("SECRET-DETAIL boom")),
});
const hanging = (provider: string): BalanceSource => ({
  provider,
  balance: () => new Promise(() => {}),
});
const check = (p: ReturnType<typeof balancePreflightPlugin>, callNumber: number, costUsd = 0) =>
  Effect.runPromise(
    p.beforeModelCall!({ callNumber, usage: { inputTokens: 0, outputTokens: 0, costUsd } }, ctx),
  );

describe("balancePreflightPlugin", () => {
  test("allows when the balance covers the estimate plus reserve; refuses with a clear message otherwise", async () => {
    const ok = balancePreflightPlugin({
      sources: [src("openrouter", 5)],
      estimateUsd: 1,
      reserveUsd: 2,
    });
    expect(await check(ok, 1)).toEqual({ kind: "allow" });
    const no = balancePreflightPlugin({
      sources: [src("openrouter", 2.5)],
      estimateUsd: 1,
      reserveUsd: 2,
    });
    expect(await check(no, 1)).toEqual({
      kind: "refuse",
      tag: "InsufficientBalance",
      message:
        "openrouter balance $2.50 is below the $3.00 needed (estimate $1.00 plus reserve $2.00)",
    });
  });

  test("only before the run by default; every N calls re-checks against what is still expected to be spent", async () => {
    const calls = { n: 0 };
    const only = balancePreflightPlugin({ sources: [src("o", 0, calls)], estimateUsd: 1 });
    expect(await check(only, 2)).toEqual({ kind: "allow" });
    expect(calls.n).toBe(0);

    const every = balancePreflightPlugin({
      sources: [src("o", 0.4)],
      estimateUsd: 1,
      everyNCalls: 3,
      cacheMs: 0,
    });
    expect(await check(every, 2)).toEqual({ kind: "allow" }); // not due
    expect(await check(every, 3, 0.7)).toEqual({ kind: "allow" }); // 0.3 still expected, 0.4 left
    expect(await check(every, 6, 0.2)).toMatchObject({
      kind: "refuse",
      tag: "InsufficientBalance",
    }); // 0.8 expected
  });

  test("a later check's message adds up: estimate minus spent, plus reserve, equals needed", async () => {
    const p = balancePreflightPlugin({
      sources: [src("openrouter", 1)],
      estimateUsd: 2,
      reserveUsd: 0.5,
      everyNCalls: 2,
      cacheMs: 0,
    });
    const d = await check(p, 2, 0.4);
    expect(d).toEqual({
      kind: "refuse",
      tag: "InsufficientBalance",
      message:
        "openrouter balance $1.00 is below the $2.10 needed (estimate $2.00 minus $0.40 already spent leaves $1.60, plus reserve $0.50)",
    });
  });

  test("a throwing or non-finite estimate is unknown: allowed by default, refused when strict", async () => {
    const boom = () => {
      throw new Error("SECRET estimate failure");
    };
    for (const estimateUsd of [boom, Number.NaN, () => Number.POSITIVE_INFINITY]) {
      const lenient = balancePreflightPlugin({ sources: [src("o", 100)], estimateUsd });
      expect(await check(lenient, 1)).toEqual({ kind: "allow" });
      const strict = balancePreflightPlugin({
        sources: [src("o", 100)],
        estimateUsd,
        onUnknown: "refuse",
      });
      const d = await check(strict, 1);
      expect(d).toMatchObject({ kind: "refuse", tag: "BalanceUnknown" });
      expect(d.kind === "refuse" && d.message).not.toContain("SECRET");
    }
  });

  test("an estimate function receives the run; the first source that answers is used; lookups are cached", async () => {
    const calls = { n: 0 };
    const p = balancePreflightPlugin({
      sources: [failing("a"), src("b", 9, calls)],
      estimateUsd: ({ runId }) => (runId === "r" ? 1 : 100),
      everyNCalls: 1,
    });
    expect(await check(p, 1)).toEqual({ kind: "allow" });
    await check(p, 2);
    expect(calls.n).toBe(1); // cached
  });

  test("unknown balance: advisory by default, strict on request; a timeout counts as unknown; no failure detail leaks", async () => {
    for (const s of [failing("a"), hanging("a")]) {
      const lax = balancePreflightPlugin({ sources: [s], estimateUsd: 1, lookupTimeoutMs: 20 });
      expect(await check(lax, 1)).toEqual({ kind: "allow" });
      const strict = balancePreflightPlugin({
        sources: [s],
        estimateUsd: 1,
        lookupTimeoutMs: 20,
        onUnknown: "refuse",
      });
      const d = await check(strict, 1);
      expect(d).toMatchObject({ kind: "refuse", tag: "BalanceUnknown" });
      expect(JSON.stringify(d)).not.toContain("SECRET-DETAIL");
    }
  });

  test("a non-finite balance is unknown, not a pass", async () => {
    const p = balancePreflightPlugin({
      sources: [src("a", Number.NaN)],
      estimateUsd: 1,
      onUnknown: "refuse",
    });
    expect(await check(p, 1)).toMatchObject({ tag: "BalanceUnknown" });
  });
});

describe("openRouterBalance", () => {
  const fetchOf = (
    status: number,
    body: unknown,
    seen: { url?: string; auth?: string } = {},
  ): typeof fetch =>
    (async (url: string, init?: RequestInit) => {
      seen.url = String(url);
      seen.auth = new Headers(init?.headers).get("authorization") ?? undefined;
      return new Response(JSON.stringify(body), { status });
    }) as never;

  test("remaining = credits - usage, with the key as a bearer and the documented path", async () => {
    const seen: { url?: string; auth?: string } = {};
    const s = openRouterBalance({
      apiKey: "k",
      baseUrl: "https://or.test/api/v1/",
      fetch: fetchOf(200, { data: { total_credits: 10, total_usage: 3.5 } }, seen),
    });
    expect(await s.balance()).toEqual({ remainingUsd: 6.5 });
    expect(seen).toEqual({ url: "https://or.test/api/v1/credits", auth: "Bearer k" });
  });

  test("a non-2xx or an unexpected shape rejects (unknown), without the body", async () => {
    await expect(
      openRouterBalance({ apiKey: "k", fetch: fetchOf(401, { error: "SECRET" }) }).balance(),
    ).rejects.toThrow("balance lookup failed: 401");
    await expect(
      openRouterBalance({ apiKey: "k", fetch: fetchOf(200, { data: {} }) }).balance(),
    ).rejects.toThrow("unexpected shape");
  });

  test("an error never carries the key", async () => {
    const err = await openRouterBalance({
      apiKey: "sk-or-SECRETKEY",
      mode: "key",
      fetch: fetchOf(403, { error: "sk-or-SECRETKEY" }),
    })
      .balance()
      .catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain("SECRETKEY");
  });

  test('mode "key": GET /key, remaining = data.limit_remaining', async () => {
    const seen: { url?: string; auth?: string } = {};
    const s = openRouterBalance({
      apiKey: "k",
      mode: "key",
      baseUrl: "https://or.test/api/v1",
      fetch: fetchOf(200, { data: { limit: 20, limit_remaining: 7.25 } }, seen),
    });
    expect(await s.balance()).toEqual({ remainingUsd: 7.25 });
    expect(seen).toEqual({ url: "https://or.test/api/v1/key", auth: "Bearer k" });
  });

  test('mode "key": a key without a spending limit (null) reads as unknown', async () => {
    await expect(
      openRouterBalance({
        apiKey: "k",
        mode: "key",
        fetch: fetchOf(200, { data: { limit: null, limit_remaining: null } }),
      }).balance(),
    ).rejects.toThrow("no spending limit");
  });
});

describe("balancePreflightPlugin with a chain-like source provider (#49)", () => {
  test("reads sources from balanceSources() on each lookup, in order", async () => {
    let lists = 0;
    const chain = {
      balanceSources: () => (lists++, [failing("x"), src("y", 0.5)]),
    };
    const p = balancePreflightPlugin({ sources: chain, estimateUsd: 1, cacheMs: 0 });
    expect(await check(p, 1)).toMatchObject({ tag: "InsufficientBalance" });
    expect(lists).toBe(1);
    const empty = balancePreflightPlugin({
      sources: { balanceSources: () => [] },
      estimateUsd: 1,
      onUnknown: "refuse",
    });
    expect(await check(empty, 1)).toMatchObject({ tag: "BalanceUnknown" });
  });
});
