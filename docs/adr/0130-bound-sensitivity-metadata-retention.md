---
status: accepted
extends: ADR-0068, ADR-0069, ADR-0081, ADR-0113, and ADR-0117
---

# Bound ordinary Sensitivity metadata to fifteen quiet days

Ordinary body-free `blocked_secret` and `quarantined` Findings are short-lived
operational diagnostics, not permanent knowledge or an audit archive. MemStore
retains them for 15 calendar days from `last_seen_at`. A newly persisted
occurrence refreshes that time. Observation rows expire independently, and a
Finding expires after its last observation is removed and its own quiet period
has elapsed. No suspected value or reversible excerpt is retained.

The existing Worker checks this obligation every six hours. It deletes at most
500 eligible observations and 500 eligible Findings in one transaction. If
eligible rows remain, the next pass is due after 30 seconds; missed checks are
coalesced into the next Worker run instead of replaying calendar ticks. Failures
use bounded exponential retry, appear in status immediately, and enter Review
Inbox only after three consecutive failures. Cleanup is deterministic and
local: it never calls Luna, Terra, or another model.

Deletion leaves aggregate maintenance counters but no per-Finding Tombstone. A
later recurrence is screened normally and receives a new Finding identity.
Active exact-revision false-positive overrides and invalidated override audit
records are separate protected safety objects and keep the lifecycle defined by
ADR-0081; this retention rule does not weaken or silently transfer an override.
