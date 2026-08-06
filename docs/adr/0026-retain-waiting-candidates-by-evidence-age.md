---
status: accepted
---

# Retain waiting candidates by evidence age

Memory Candidate retention is measured from the most recent materially new, valid, provenance-bound evidence recorded as `last_evidence_at`, not from the most recent processing attempt or duplicate observation. Ordinary waiting candidates default to 90 calendar days. High-value candidates, candidates linked to an unresolved Verification Request, and candidates held by a material conflict default to 180 calendar days. Both durations are configurable. A user-pinned candidate does not expire automatically.

Retries, repeated extraction of the same support, Memory Echoes, reads, ranking outcomes, and governance no-ops do not update `last_evidence_at`. This prevents a low-value or self-reinforcing candidate from remaining forever merely because MemStore repeatedly encounters or processes it. Materially new evidence does update the timestamp and triggers re-evaluation.

Crossing a retention deadline creates an idempotent expiration obligation in the Governance Ledger; a timer does not directly expire or delete the candidate. A successful governance evaluation must recheck the candidate's current evidence, value class, protection, unresolved requests, conflicts, and configured policy before committing `expired`.

A candidate cannot expire merely because Luna, the network, the Distillation Worker, the Memory Vault, or a governance backlog denied it a required successful processing opportunity. Catch-up processing evaluates overdue candidates after recovery. Downtime is not evidence against a claim, and a failed or missing assessment is never treated as approval to expire it.

This policy preserves single-occurrence but potentially important knowledge long enough to acquire support while bounding ordinary candidate accumulation. The post-expiration body-removal and minimal-record retention policy is a separate decision.
