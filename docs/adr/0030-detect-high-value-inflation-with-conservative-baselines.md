---
status: accepted
---

# Detect high-value inflation with conservative baselines

MemStore does not impose a hard count or percentage quota on High-value Memory Candidates. A complex or long-running Session may legitimately produce many important items, so exceeding a volume target cannot delete, demote, reject, or expire a candidate. Governance work may be deferred within bounded processing budgets without discarding queued knowledge.

Inflation metrics include only Agent-derived Candidates whose high-value classification Luna proposed through the automatic path. The denominator excludes Direct Human Assertions, explicit user pins, duplicates, Memory Echoes, retries, and candidates routed to stronger handling by deterministic Global or Human-conflict rules.

The first-version conservative provisional-anomaly defaults are:

- **Session burst:** at least 12 eligible candidates in one Session, of which at least 10 are classified high-value;
- **Project rolling change:** at least 50 eligible candidates in the current 30-day window and at least 100 eligible candidates in the preceding 90-day baseline, with a current high-value rate of at least 60% and at least 25 percentage points above baseline;
- **Cold start:** before 100 historical eligible candidates exist, at least 50 current candidates with a high-value rate of at least 80%; and
- **Tag dominance:** at least 20 high-value candidates in the current window, with one `importance_tag` present on at least 80% of them.

A threshold crossing first creates a `provisional` High-value Inflation event. It becomes `persistent` only when two consecutive non-overlapping windows or two consecutive Weekly Maintenance evaluations remain anomalous. A one-off architecture-heavy Session therefore schedules diagnosis without becoming a user-visible model-quality conclusion.

Only persistent anomalies enter the governance digest and the bad-case repair dataset. They carry aggregate measurements and representative Candidate identities for later diagnosis, but neither provisional nor persistent state changes candidate truth, authority, retention, evidence, or lifecycle automatically.

The thresholds and metric definitions are versioned configuration. Shadow Mode evaluates their fit against the user's real distribution and may propose changes with supporting measurements. Luna, metrics, scheduled governance, and Shadow Mode cannot silently update the active thresholds; a change requires explicit human Review.
