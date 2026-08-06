---
status: accepted
---

# Use compact representations at SessionStart

SessionStart uses only a validated `compact` representation of at most 96 rendered body tokens or the accepted `identity` fallback. This applies equally to eligible `startup: always` and dynamically ranked candidates. It does not inject a `standard` representation or full Canonical Memory body because no task-specific prompt exists to justify the additional detail.

A `standard` Injection Snippet may use at most 192 rendered body tokens and follows the same Semantic Contract, sensitivity, revision-binding, and validation requirements. A `high` UserPromptSubmit result may use standard form when the extra detail materially improves task-specific use. `probable` remains compact-only. Explicit identity-based retrieval may return standard or progressively deeper content under its separate budget policy.

Representation level does not change priority, authority, evidence, relevance, or scope. A longer representation does not gain selection preference merely because it contains more text.
