# Incident report — payment-service intermittent 500s

**Date:** 2026-04-18 14:02 UTC
**Authors:** P. Singh, M. Kowalski
**Severity:** SEV2
**Duration:** 22 minutes (14:02–14:24 UTC)
**Status:** Resolved

## Summary

Between 14:02 and 14:24 UTC, the public payment-service API returned HTTP 500 to approximately 3.4% of checkout requests across all regions. Customers attempting card payments saw an "Unable to process payment" page; saved-method and Apple-Pay checkouts were unaffected. No payment data was lost.

## Timeline

- 14:01 UTC — Auto-scaler added two new `payment-svc` pods to absorb daily traffic spike.
- 14:02 UTC — Error-rate alert fires (>1% 5xx for 60s).
- 14:05 UTC — On-call (P. Singh) acknowledged. Begins inspecting recent deploys.
- 14:11 UTC — Hypothesis: the new pods are using a stale `secrets-cache` snapshot. Confirmed via `kubectl describe`.
- 14:18 UTC — Mitigation: deleted the two new pods, restored the in-flight pods. Error rate drops to baseline within 90s.
- 14:24 UTC — Alert cleared. Postmortem owner assigned.

## Root cause

The `secrets-cache` sidecar refreshes its snapshot of the secrets manager every 30 minutes. New pods spawned via the auto-scaler bootstrap from a cached snapshot file on the node — that file was 31 minutes old when the two new pods came up, and the upstream PSP (payment service provider) credentials had been rotated 18 minutes prior. Calls from those two pods failed PSP authentication and were returned to clients as opaque 500s.

## What went well

- Alert fired within 60 seconds of the symptom.
- On-call was paged correctly and engaged within 4 minutes.
- Rollback (deleting the new pods) was understood and reversible.

## What didn't

- The PSP credential rotation runbook does not mention the secrets-cache snapshot TTL.
- The auto-scaler did not health-check the new pods against a synthetic PSP call before adding them to the load-balancer pool — they served live traffic from `Ready=true`.
- The 500 returned to clients gave no detail; debugging required reaching for pod logs because PSP auth failures don't surface in any dashboard.

## Action items

- (P0) Replace the snapshot-file bootstrap with a direct secrets-manager fetch on pod start. Owner: P. Singh, due 2026-04-25.
- (P1) Add a PSP synthetic check to the readiness probe. Owner: M. Kowalski, due 2026-05-02.
- (P2) Update the credential-rotation runbook to call out the cache TTL invariant. Owner: P. Singh, due 2026-04-23.
- (P2) Surface PSP auth failures in the payments dashboard so they aren't buried in pod logs. Owner: D. Owusu, due 2026-05-09.

## Impact

- Failed checkouts: ~1,840 (3.4% of attempts during window).
- Revenue impact: estimated $46K (most users retried successfully within 5 minutes).
- No SLA breach (SLA is 99.5% monthly; current month tracks at 99.94%).
