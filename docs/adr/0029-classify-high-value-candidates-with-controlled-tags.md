---
status: accepted
---

# Classify high-value candidates with controlled tags

High-value Memory Candidate classification affects retention, validation depth, and governance priority, but it does not prove truth, increase content authority, or authorize promotion. The system therefore does not use a free-form Luna confidence or importance score as the classification authority.

Luna may propose one or more controlled `importance_tags` together with a bounded reason and evidence references. The local deterministic Promotion Gate confirms whether the proposal satisfies the reviewed category and evidence rules. A user can explicitly pin a candidate to protect it from automatic expiration, but pinning does not bypass verification, scope, sensitivity, or conflict handling.

The first-version high-value categories are:

- an explicit user decision, stable preference, constraint, or exception expected to affect later Sessions;
- an architecture invariant, API contract, security boundary, data-loss risk, or irreversible-operation requirement;
- a supported failure root cause, effective repair, recovery procedure, or recurrence hazard;
- environment, toolchain, build, deployment, or debugging knowledge that would be expensive to rediscover; and
- a material limitation, negation, or applicability correction to an existing general rule.

Routine activity or progress, temporary branch or task status, a command record without a reusable conclusion, an unverified future plan, a duplicate with no new information, and a Memory Echo are not high-value by default. A candidate can still remain in the ordinary lifecycle when it is not high-value.

Confirmed high-value status grants the accepted 180-day default Candidate Retention period, routes incomplete or semantically ambiguous evidence to the full validation path, and raises processing priority within bounded governance work. It cannot make the claim Durable Memory, allow normal recall, or override Human-authored Memory.
