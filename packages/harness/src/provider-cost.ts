/**
 * Provider-billed cost: `withProviderCost` lives in `@droveragent/model` next to
 * the shared per-attempt response tap (one `fetch` patch for billed cost and
 * structured provider errors). Re-exported here so `@droveragent/harness`
 * users keep importing it from the harness.
 */
export {
  attemptTapInstalled as providerCostTapInstalled,
  liveAttemptTaps as pendingProviderCostCalls,
  withProviderCost,
} from "@droveragent/model";
