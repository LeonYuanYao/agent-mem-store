---
status: accepted
---

# Review adaptive Shadow evidence after seven days

Shadow Mode runs for at least seven consecutive calendar days before Full Cutover can be reviewed. It has no predeclared hard quotas for Sessions, retrieval opportunities, non-empty packs, or manually sampled items. Actual coverage and confidence are reported truthfully.

During the window, MemStore records Sessions, retrieval opportunities, non-empty packs, selected candidates, explicit deep reads, irrelevant observations, latency, failures, and recovery evidence. At the end, the Readiness Report uses the observed data distribution to propose quality thresholds and targeted additional observation. Sparse evidence may be reviewed in full; abundant evidence is sampled across Project, scope, authority, Relevance Band, and anomaly type. Configuration comparisons need not claim formal statistical significance.

Ordinary irrelevant-rate, recall-rate, and sample-count thresholds therefore remain adaptive until the Review. The p95 300-millisecond SLO and the current one-second fail-open product target from ADR-0114 remain observable without a minimum request-count fiction.

Safety and correctness are not adaptive: any confirmed Secret body leakage; unauthorized, wrong-Project, cross-Project Private, Candidate, unresolved-conflict, expired, or rejected automatic injection; silent acknowledged-event loss; duplicate Canonical or governance effect from replay; or foreground blocking instead of fail-open prevents cutover.

Crash, sleep, network, Luna, Vault-write, duplicate-delivery, and native-configuration rollback exercises may be performed during the seven-day window. Accepted archive purge and foreground repair prerequisites still apply.

The Readiness Report presents actual coverage, quality observations, fixed-gate results, performance, recovery exercises, Bad Cases, unresolved risks, and the exact configuration diff. It never changes live configuration. The user explicitly chooses to approve cutover, extend Shadow for named evidence gaps, or require repair and renewed observation.
