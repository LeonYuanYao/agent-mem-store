---
status: accepted
---

# Aggregate Sensitivity Quarantine for human review

Sensitivity Findings remain exact body-free safety records, but Review Inbox is
an action surface rather than a mirror of that ledger. It groups unresolved
Quarantines by risk category and body-free `agent:event_kind`, reports exact
finding and occurrence totals, and shows at most three recent Finding identities
per group. Complete identity-level metadata remains queryable in Machine-local
Runtime Data through `sensitivity status` and `sensitivity inspect`; suspected
values are never retained or reconstructed.

New observations retain only the bounded source kind needed to locate detector
concentration. Historical observations are labeled `legacy_unknown`; MemStore
does not infer their source or weaken quarantine to improve metrics. An exact
false-positive decision still requires an unchanged readable source or explicit
safe resubmission. We rejected per-Finding Inbox rendering because audit volume
made the human surface unusable, and rejected storing excerpts because that
would violate the containment boundary the review is meant to protect.
