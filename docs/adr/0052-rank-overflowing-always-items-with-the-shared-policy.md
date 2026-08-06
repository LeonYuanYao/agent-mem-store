---
status: accepted
---

# Rank overflowing always items with the shared policy

When eligible `startup: always` content exceeds its permitted capacity, the first version does not introduce a separate numeric `startup_order` or hidden weight. The pool is safety-filtered and deduplicated, then uses the accepted effective priority tiers, current-Project one-tier promotion, lexicographic ranking key, within-tier category rotation, and `compact`-then-`identity` representation fallback.

Selection stops at the 600-token `always` ceiling or the shared total-item and identity-item limits. Every omitted candidate records its precise filter, duplicate, representation, item-limit, identity-limit, or token-limit reason in the Injection Receipt and contributes to the accepted bounded persistent overflow status.

The selected `always` region is assembled before the dynamic region. Dynamic candidates cannot displace selected always content within its permitted ceiling. Unused always capacity may flow to the dynamic region under the previously accepted rule.
