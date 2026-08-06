---
status: accepted
---

# Rank Project and Global Core Memory without fixed quotas

The SessionStart dynamic Core Memory area has no fixed Project-to-Global token or item ratio. Eligible current-Project Memory receives an explicit ranking boost, while Global Memory competes in the same pool and may outrank a weaker Project item when it has greater stable utility or authority.

Unused capacity flows in either direction. A Project with little eligible core knowledge can use Global items without preserving empty Project slots, and a Project with strong core knowledge can use capacity that would otherwise have gone to Global. The separate accepted `startup: always` 600-token ceiling and the overall 1,200-token Core Memory Pack limit remain unchanged.

Dynamic ranking favors stable preferences, architectural or safety invariants, durable decisions, recurring engineering hazards, recovery knowledge, and toolchain rules. Category diversity prevents repeated knowledge of one type from filling the pack. Usage and explicit deep-read history may contribute only a small capped utility signal; they do not prove correctness, change authority, or allow frequently repeated low-value content to dominate.

Eligible candidates first receive an explainable priority tier. `critical` covers stable Human-authored preferences or constraints, safety or architectural invariants, and active durable decisions. `strong` covers verified recurring hazards, recovery knowledge, and toolchain rules. `normal` covers other eligible long-lived knowledge. Current-Project scope promotes a candidate by exactly one tier, from `normal` to `strong` or from `strong` to `critical`, with `critical` as the ceiling. This promotion does not modify authority, evidence, lifecycle, relevance, or applicability, so a Global `critical` candidate may still rank ahead of a current-Project `strong` candidate.

Usage and explicit deep-read history contribute at most a small capped tie-break signal within a tier and cannot promote a candidate to another tier. Stable knowledge is not demoted solely because it is old. Recency participates only for content explicitly modeled as time-sensitive through validity or last-confirmed metadata.
