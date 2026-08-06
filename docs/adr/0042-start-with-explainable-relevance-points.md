---
status: accepted
---

# Start with explainable relevance points

The first version uses an explainable point model for automatic per-prompt Relevance Bands. Hard safety, lifecycle, scope, and explicit incompatibility filters run before scoring and cannot be offset by accumulated points.

The initial signals are:

- direct Memory identity reference: `+5`;
- exact file, symbol, error code, command, or entity match with no applicability conflict: `+4`;
- very strong semantic match: `+4`;
- strong semantic match: `+2`;
- moderate semantic match: `+1`;
- strong lexical match: `+2`;
- moderate lexical match: `+1`;
- bounded structured Session-signal match: `+1`;
- explicit applicability match: `+1`;
- one-hop relationship from an already relevant seed: `+1` at most once; and
- broad topic similarity alone: `0`.

Scores of 4 or greater are `high`, scores 2 or 3 are `probable`, and scores 1 or less are `weak`. Weak candidates do not consume automatic item or token allowance but remain visible to explicit recall and diagnostics.

For the first selected embedding adapter, normalized semantic scores of at least 0.82 are very strong, 0.70 through less than 0.82 are strong, 0.58 through less than 0.70 are moderate, and lower scores contribute no semantic points. These thresholds are versioned with the embedding model and normalization adapter; a material model or normalization change invalidates them.

A strong lexical match is a top-three BM25/FTS result with at least 60% effective query-term coverage or a high-distinctiveness complete phrase. A moderate lexical match is a top-ten result with at least 30% effective coverage. Tokenization and distinctiveness rules are versioned with the lexical adapter.

Reciprocal Rank Fusion orders candidates within a band. Exact metadata, current-Project priority, applicability, authority, evidence, redundancy, and diversity are documented tie-breakers or pack-selection inputs rather than hidden alterations to the band formula. Every automatic decision records its contributing signals and adapter versions in the Injection Receipt.

These defaults are an engineering starting point, not a universal similarity standard. Shadow Mode reports available evidence, but insufficient data does not block the defaults from remaining active. Luna, Shadow Mode, metrics, and governance cannot change them without explicit human Review.
