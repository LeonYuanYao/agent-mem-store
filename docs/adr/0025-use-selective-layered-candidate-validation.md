---
status: accepted
---

# Use selective layered validation for Agent-derived candidates

MemStore does not require a knowledge claim to appear more than once before it can become Durable Memory. Repetition can increase support or reveal stability, but it is not a hard eligibility condition. A decision, constraint, preference, fact, or lesson observed once may still be important and promotable when its statement, applicability, provenance, and evidence are sufficiently clear.

Candidate validation is selective rather than uniformly model-heavy. An ordinary Agent-derived candidate with clear provenance, no material conflict, and sufficient machine-checkable evidence follows a lightweight path. The Luna call that distilled the candidate is not followed by a second semantic verification call solely for procedural consistency.

Lightweight promotion is controlled by an evidence-class allowlist rather than a numeric Luna confidence threshold. A single source is eligible only when it is one of the following and the extracted claim preserves its scope and certainty:

- an explicit user statement of a stable decision, constraint, or preference, linked to the source message;
- a code or configuration fact bound to a file content identity and the applicable repository revision;
- a command or test outcome whose captured evidence includes the command, working directory, time, exit status, and an intact bounded result; or
- an exact reference to existing Human-authored Memory that adds no inferred claim.

A user statement encountered in ordinary conversation is evidence for an Agent-derived extraction; it becomes a Direct Human Assertion only through the separately defined Manual Memory Directive boundary. Lightweight promotion therefore does not grant Human-authored authority to Luna's wording.

The following are not eligible for the lightweight path: an Agent summary without underlying evidence, truncated or integrity-ambiguous tool output, speculative language, a future plan, transient state, unclear applicability, a material conflict, or a conclusion synthesized across multiple observations. Such candidates take the full validation path or wait for additional evidence. A model confidence value may be retained for diagnostics, but it cannot change evidence eligibility or authorize promotion.

The full validation path is required for Global candidates, material conflicts, cross-Batch or cross-Session consolidation, Review Suggestions that could affect Human-authored Memory, and high-value candidates whose available evidence is incomplete or semantically ambiguous. It has three distinct responsibilities:

1. Local Deterministic Evidence Checks verify existing source identity, content identity, Git revision where applicable, captured command-result integrity, provenance links, scope, schema, sensitivity, and conflict state without relying on an LLM.
2. Luna performs Semantic Evidence Assessment only when deciding whether the cited evidence supports the candidate requires language understanding. Its output is structured and evidence-citing, using bounded states such as supported, partially supported, contradicted, and insufficient evidence. It cannot invent missing evidence or authorize promotion.
3. A local deterministic Promotion Gate applies the reviewed authority, scope, sensitivity, conflict, and evidence policy and commits promote, merge, wait, conflict, reject, or expire. Model confidence, prose, or repeated occurrence cannot bypass that state machine.

Validation normally operates only on evidence MemStore has already captured or can inspect read-only within its authority. If sufficient verification would require running a test, build, deployment, privileged command, or high-risk external operation, background governance creates a durable Verification Request describing the evidence gap and proposed action. It does not execute the action silently. Completing a request contributes new provenance-bound evidence and triggers candidate re-evaluation; it does not force promotion.

Luna unavailability leaves full-path candidates waiting or retryable and never counts as approval. Independently valid deterministic checks and lightweight-path governance may continue. This boundary preserves low-friction capture for ordinary knowledge while applying stronger scrutiny to high-impact or uncertain claims.
