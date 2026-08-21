---
status: accepted
---

# Hold non-long-term Candidates before Canonical promotion

Every newly distilled Agent-derived Candidate carries a structured durability
assessment from the existing Luna distillation call. The assessment distinguishes
`long_term`, `project_phase`, and `session_only`; states a concrete future reuse
scenario, horizon, invalidation triggers, abstraction level, and whether the
claim can be observed again from the current workspace. Luna may return no
Candidate when evidence contains only task-local status or progress.

The deterministic Promotion Gate applies durability to lightweight evidence as
well as the full semantic-assessment path. During the first reviewed rollout,
only `long_term` Candidates continue through the existing Promotion Gate. New
`project_phase`, `session_only`, or unclassified Candidates remain in the
existing `waiting` lifecycle with explicit hold reasons. They do not become
Canonical Memory or participate in normal recall, but their bounded Runtime
body, evidence, and provenance remain available for reviewed re-evaluation.
Direct Human Assertions are unchanged.

The hold is deliberately reversible. It prevents continued Vault inflation
without permanently rejecting a potentially important one-off observation
before the new classifier has real-data evidence. A later reviewed milestone
may reject `session_only`, promote `project_phase` with a bounded `validUntil`,
or release false-positive holds. Historical Candidates without the new fields
retain their existing behavior and are governed separately.

Shadow reporting records the old decision, durability result, hold reason, and
bounded body-free diagnostics. It exposes aggregate counts and a bounded set of
Candidate identities for explicit review; it does not copy Candidate bodies
into the report. This decision extends ADR 0025 and closes the lightweight-path
gap in ADR 0098 without adding another Luna invocation.
