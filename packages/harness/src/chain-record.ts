import type { ChainRecordEntry, HarnessEvent, Usage } from "@droveragent/core";
import { canonicalProvider } from "@droveragent/model";

type Notice = Extract<HarnessEvent, { kind: "provider_failover" }>;

/** Adds `b` into `a` (tokens and cost). */
export const addUsage = (a: Usage, b: Usage): Usage => {
  const out: Usage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
  const cr = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  if (cr > 0) out.cacheReadTokens = cr;
  const cw = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  if (cw > 0) out.cacheWriteTokens = cw;
  if (a.reasoningTokens !== undefined || b.reasoningTokens !== undefined)
    out.reasoningTokens = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  const c = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  if (c > 0) out.costUsd = c;
  return out;
};

const emptyEntry = (provider: string): ChainRecordEntry => ({
  provider,
  answered: 0,
  failed: 0,
  failures: Object.create(null) as Record<string, number>,
  benchedAtTurn: null,
  usage: { inputTokens: 0, outputTokens: 0 },
});

/**
 * The per-run provider chain record (`RunResult.chainRecord`, the `chain_record` trace event):
 * one entry per configured provider, in chain order, including providers that only failed.
 * Built from the chain's failover notices and the served assistant messages; never from
 * provider text. `seed` is the record of the run's previous invocation (a resume or
 * continuation), which this one appends to.
 */
export function createChainRecorder(
  providers: readonly string[],
  seed?: ReadonlyArray<ChainRecordEntry>,
) {
  const entries = new Map<string, ChainRecordEntry>();
  for (const p of providers) entries.set(p, emptyEntry(p));
  // A checkpoint written under the pre-1.0.3 Azure name carries it as `azure-openai-responses`:
  // read it as `azure`. Two seed rows that map to one provider are merged, never dropped.
  const seen = new Set<string>();
  for (const s of seed ?? []) {
    // Only providers still in the chain, in the chain's current order; counts carried over.
    const e = entries.get(canonicalProvider(s.provider));
    if (!e) continue;
    const again = seen.has(e.provider);
    seen.add(e.provider);
    e.answered = (again ? e.answered : 0) + s.answered;
    e.failed = (again ? e.failed : 0) + s.failed;
    for (const [k, v] of Object.entries(s.failures ?? {}))
      if (typeof v === "number") e.failures[k] = (again ? (e.failures[k] ?? 0) : 0) + v;
    const benched = typeof s.benchedAtTurn === "number" ? s.benchedAtTurn : null;
    e.benchedAtTurn = again ? (e.benchedAtTurn ?? benched) : benched;
    e.usage = again ? addUsage(e.usage, s.usage) : { ...s.usage };
  }
  return {
    /** A failed attempt (`retry`, `failover` or `exhausted`) of `notice.from`. */
    onNotice(notice: Notice, turn: number): void {
      const e = entries.get(notice.from);
      if (!e) return;
      e.failed += 1;
      e.failures[notice.failureClass] = (e.failures[notice.failureClass] ?? 0) + 1;
      if (notice.benched === true && e.benchedAtTurn === null) e.benchedAtTurn = turn;
    },
    /** An assistant message served by `provider`: its usage, and an answer unless it is an error. */
    onMessage(provider: string, usage: Usage, answered: boolean): void {
      const e = entries.get(provider);
      if (!e) return;
      if (answered) e.answered += 1;
      e.usage = addUsage(e.usage, usage);
    },
    record(): ChainRecordEntry[] {
      return [...entries.values()].map((e) => ({
        ...e,
        failures: Object.assign(Object.create(null) as Record<string, number>, e.failures),
        usage: { ...e.usage },
      }));
    },
  };
}

/** The last `chain_record` among a run's stored events, if any. */
export function lastChainRecord(
  events: ReadonlyArray<{ kind: string; payload: unknown }>,
): ReadonlyArray<ChainRecordEntry> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.kind !== "chain_record") continue;
    const providers = (ev.payload as { providers?: unknown }).providers;
    if (Array.isArray(providers)) return providers as ChainRecordEntry[];
  }
  return undefined;
}
