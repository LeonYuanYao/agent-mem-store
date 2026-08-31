---
status: accepted
extends: ADR-0040, ADR-0042, and ADR-0120
---

# Require discriminative item evidence for automatic Top-N

Automatic UserPromptSubmit retrieval treats the six-item limit as a ceiling, not a target. Every
selected Memory must independently reach its Relevance Band; foreground packing does not fill
unused positions with weaker items merely because they share the current Project or topic.

The Snapshot search projection uses one deterministic tokenizer for indexed documents and query
terms. It retains normalized complete tokens, extracts Latin identifier runs across script
boundaries, and adds two-character n-grams for Han, Hiragana, and Katakana runs. This lets a query
such as `默认平台` retain evidence against `默认目标平台` without a foreground model call.

Lexical and applicability coverage is weighted by scoped document frequency. Query terms absent
from the current scope remain in the coverage denominator with a neutral minimum weight; they do
not become artificially rare evidence. A term that appears in the scope receives its local IDF
weight. The existing 64-term and bounded-candidate limits remain unchanged.

An exact prompt token is a primary exact anchor only when it meets one of these deterministic
conditions:

- it is a direct portable or canonical Memory identity reference;
- at least two distinct exact terms match and their weighted exact coverage is at least 50%;
- one matched exact term contains at least three Unicode code points and occurs in at most 1% of
  the eligible scope, with a one-document minimum;
  or
- a bounded structured Session signal matches.

A shared Project or product token can still retrieve candidates, but one such non-distinctive
token cannot award the full exact score or independently corroborate semantic similarity. A rare
two-character acronym is also insufficient by itself because identifiers such as `MR`, `PR`, and
`CI` are ambiguous across unrelated workflows; it must match with another independent term.
Applicability requires either two matched terms with at least 25% weighted coverage, or one rare
matched term of at least three Unicode code points with at least 15% weighted coverage. These
values are reviewed deterministic policy;
Luna, Terra, embeddings, metrics, and governance cannot change them automatically.

Semantic similarity ranks and supports candidates only after independent exact, lexical,
applicability, or structured evidence, except for the already-reviewed standalone semantic Top-1
margin gate. One-hop relationship evidence may improve ordering within an independently reached
band but cannot promote a Memory into a higher band.

The implementation adds no network or model call. The search projection remains derived,
in-memory Runtime Data. A conservative 594-document full-Markdown benchmark increased complete
tokenization and projection construction from about 33 to 37 milliseconds and increased heap use
by about 5.6 MB; production snapshots contain less duplicate text and reuse the resident
projection. The 300-millisecond warm-path SLO and one-second fail-open boundary remain unchanged.
