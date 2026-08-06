---
status: accepted
---

# Distinguish direct human assertions from model extractions

When a user explicitly supplies the knowledge statement to remember, MemStore treats that statement as a Direct Human Assertion and therefore as Human-authored Memory. Project or Global scope comes from the user's directive. Luna may normalize structure or wording, but only while preserving the user's claims, conditions, scope, and certainty. It must not silently infer new facts, broaden applicability, remove qualifications, or increase confidence under human authority.

Any inferred, expanded, or materially reinterpreted output is separated from the Direct Human Assertion and handled as an Agent-derived Memory Candidate. The same Agent-derived classification applies when the user asks Luna or another Agent to extract knowledge from the current turn, selected material, or a complete session. Explicitly authorizing Project or Global scope authorizes placement only; it does not confirm the model's extracted content or bypass the candidate promotion policy.

Both paths retain provenance, sensitivity screening, deduplication, conflict handling, and traceable operation identity. Human authority does not permit Secret Content to enter prohibited storage or disclosure paths, and a new Direct Human Assertion must not silently overwrite an existing conflicting Human-authored Memory. ADR-0017 defines the accepted same-authority conflict behavior.
