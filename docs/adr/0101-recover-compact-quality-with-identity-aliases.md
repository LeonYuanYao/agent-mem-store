---
status: accepted
---

# Recover compact quality with identity aliases and semantic validation

Compact generation and fidelity validation use deterministic short aliases such
as `m1` and `m2` for model-facing Memory identities. MemStore restores the exact
canonical identities locally and rejects unknown, missing, or duplicate aliases.
Luna never has to reproduce a canonical UUID character by character.

Generation targets 64 rendered tokens for headroom. A draft measured above the
96-token hard limit receives one focused Luna compression pass. If the repaired
draft is still overlong, it is recorded as explicitly not compactable under the
current budget instead of spending the schema retry allowance. The full Memory
remains unchanged, and MemStore never truncates the text mechanically.

The local compact gate owns only deterministic facts: the candidate is non-empty,
fits the rendered-token ceiling, passes local sensitivity classification, and is
still bound to the current revision and content identity. It does not require a
semantic condition, exclusion, or negation to appear as a verbatim substring.
The independent Luna fidelity stage owns semantic preservation and rejects lossy
or uncertain paraphrases before publication.

Schema-invalid retries preserve a lifetime attempt count and a per-epoch attempt
count. One epoch contains the first attempt plus no more than six automatic
retries. Repeated structural failures reduce the claimed cohort from 16 to 8, 4,
2, and 1 so one malformed result cannot block unrelated Memories. Quality state
persists only the bounded Luna diagnostic stage, code, and optional path; provider
output, stderr, and Memory bodies are not retained as diagnostics.

`quality retry` is the explicit recovery surface for terminal work affected by
the superseded identity transport or verbatim-anchor gate. Preview reports the
exact eligible counts. Applying it opens a new retry epoch while preserving the
lifetime attempt count. Existing locally valid generated compacts resume at
fidelity validation; only blocked or still locally invalid work regenerates.

This decision refines ADR 0048 and ADR 0098. It applies the identity-alias and
structural-recovery principles of ADR 0092 to compact representation work.
