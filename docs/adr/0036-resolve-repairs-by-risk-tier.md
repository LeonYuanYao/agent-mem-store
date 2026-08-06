---
status: accepted
---

# Resolve repairs by risk tier

Applying a change and resolving a Bad Case are distinct operations. The evidence required for `resolved` depends on the repair's risk class.

## Class A: deterministic implementation or instrumentation

A class A repair may become `resolved` at Review Gate 2 without a further runtime observation period when a pre-fix regression test reproduces the failure, the post-fix version passes that test and the affected suite, the original Bad Case offline replay passes, and no known regression is introduced.

## Class B: Prompt, retrieval ranking, or thresholds

A class B repair may become `resolved` at Review Gate 2 without a further runtime observation period when the original Bad Cases and protected regression set were frozen before modification; all explicitly user-reported cases pass; the aggregate representative target is met; irrelevant injection does not worsen; critical recall does not decrease; no scope, authority, sensitivity, or conflict boundary regression appears; and the repair did not weaken evaluation labels, protected data, or acceptance thresholds to manufacture success.

## Class C: authority, scope, sensitivity, and other safety boundaries

A class C repair enters `monitoring` only after tests pass and Review Gate 2 authorizes controlled activation. It becomes `resolved` after at least seven consecutive calendar days and at least 30 Relevant Safety Opportunities with zero known authority, scope, Secret, Human-authored, or equivalent boundary violations.

A Relevant Safety Opportunity is an observed runtime decision that actually traverses the affected gate. Ordinary Sessions, unrelated Turns, and duplicate replay do not count. Any relevant violation fails the current monitoring cycle; a new repair starts a new cycle.

If seven days pass with fewer than 30 opportunities, monitoring continues automatically for at most 14 days total. At 14 days, insufficient opportunity coverage cannot auto-resolve the case. The user chooses continued monitoring or `resolved_with_limited_evidence`. That explicit state records actual opportunities, missing coverage, decision provenance, residual risk, and the rollback version.

Class C monitoring preserves the prior version and a verified rollback path. A later matching failure creates a linked regression case without deleting the evidence or decision that supported the earlier state.
