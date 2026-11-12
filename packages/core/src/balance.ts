/**
 * A provider's own balance lookup, for admission control (the balance preflight plugin).
 * Host-level and optional: a provider chain can carry one per provider, and nothing in the
 * chain's failover depends on it.
 */
export interface BalanceSource {
  /** Provider name, for messages (never a key). */
  provider: string;
  /** Remaining spendable USD. May throw or reject: that is "unknown". */
  balance(signal?: AbortSignal): Promise<{ remainingUsd: number }>;
}

/** Anything that can list balance sources, e.g. a provider chain (`chain.balanceSources()`). */
export interface BalanceSourceProvider {
  balanceSources(): ReadonlyArray<BalanceSource>;
}
