---
status: accepted
extends: ADR-0123 and ADR-0128
---

# Normalize automatic exact-term boundaries

Automatic prompt retrieval must not treat sentence punctuation as technical identity.
Strip trailing periods and colons from extracted exact terms before document-frequency
lookup, matching and singleton classification. Keep internal punctuation in API names,
filenames, paths and error identifiers intact.

A bounded general vocabulary of prose and configuration words is ineligible for the
corpus-rare singleton shortcut, including uppercase spellings such as `NAME` and
`VERSION`. This restriction applies only to that shortcut. These words still contribute
to existing lexical, applicability and multi-term exact evidence. Direct Memory references
and structured Session signals retain their existing behavior.

This is the narrow boundary-only policy accepted after an offline keyword ablation.
General stop-word removal, replacement Chinese segmentation and term-weight changes are
not part of this decision: shrinking a query's coverage denominator can accidentally
promote unrelated items, while broader suppression can remove useful matches.

Embedding query text, adapter identity, semantic thresholds, contextual recall, relevance
points, packing budgets and explicit recall are unchanged. The change needs no network
or model call, schema migration, canonical-memory rewrite or embedding/index rebuild.
An already running retrieval Worker must reload the built code to adopt the policy.

Regression tests use the public automatic-pack interface with isolated data: punctuation
and uppercase generic singleton false positives, real identifiers before sentence
punctuation, and corroborated generic-field matches. Model mocks establish these routing
contracts, not population-level retrieval quality.
