---
status: accepted
extends: ADR-0048, ADR-0054, ADR-0098, and ADR-0123
---

# Prevent representation gaps and ambiguous singleton recall

An enabled compact-quality pipeline queues every newly written Agent-derived Active Memory revision
whose compact representation is not valid for that revision. Candidate promotion therefore makes
representation work pending in the same catalog transaction as the Canonical write. The weekly scan
remains a reconciliation pass for missed or legacy work; it is not the normal discovery path for new
revisions. Disabling the quality pipeline continues to prevent automatic representation work.

UserPromptSubmit may use a validated standard representation as the initial representation for a
`high` candidate when no validated compact or identity representation is available and the standard
body is at most 96 rendered tokens. This fallback consumes no more body budget than an eligible
compact. It does not apply to `probable`, post-soft, or SessionStart packs, and a longer standard
representation remains eligible only through the existing second-phase upgrade rules.

A single rare exact term may independently anchor automatic relevance only when its prompt spelling
looks like a structured technical identifier: it contains a digit or an identifier delimiter such
as `.`, `_`, `:`, `/`, or `-`, or it contains at least two uppercase letters before normalization.
A plain natural-language word such as `registry` cannot become a strong exact anchor by corpus rarity
alone. It can still contribute to multi-term exact coverage, lexical ranking, applicability, and
semantic corroboration. Direct Memory references and structured Session signals are unchanged.

UserPromptSubmit receipts distinguish `representation_unavailable`, `budget_not_fit`, and
`item_limit`. Public receipt inspection exposes bounded omission details, and status reports the
number of `high` UserPromptSubmit candidates omitted for unavailable representations against the
active index. This makes a representation backlog visible without treating every omission as a
token-budget failure.

The change adds no foreground model or network call. The fallback reads fields already present in
the immutable Retrieval Snapshot, and the exact-term refinement is deterministic. The existing
300-millisecond warm-path SLO and one-second fail-open boundary remain unchanged.
