---
status: accepted
---

# Use hard safety filters and graded relevance

Automatic retrieval keeps hard boundaries for safety, lifecycle, scope, explicit applicability, and repeated revision injection. Secret Content, non-active lifecycle states, unresolved conflict bodies, unauthorized scopes, definitively incompatible validity, platform, or version conditions, and the same Memory revision already injected in the current Context Epoch cannot compete.

Relevance is not an excessively strict all-or-nothing gate. MemStore combines lexical search, embedding similarity, exact metadata, bounded structured Session signals, applicability, and one-hop relationships to place otherwise eligible candidates in `high`, `probable`, or `weak` Relevance Bands.

`high` candidates compete normally for the Relevant Memory Pack. `probable` candidates may participate in a more compact, identity-addressable representation that preserves the key claim and lets the Agent use Explicit Deep Retrieval when useful. `weak` candidates do not enter automatic injection but remain discoverable through explicit recall.

Lexical and semantic search do not both need to match. A sufficiently specific embedding-only result may qualify when scope and applicability align, and a distinctive lexical or exact metadata match may qualify independently. Generic similarity such as merely sharing a broad programming topic remains weak.

Authority and evidence affect ordering and framing but cannot manufacture relevance. Recency is applied only to time-sensitive knowledge and does not penalize a stable rule solely for age. Relationship expansion starts only from a high or probable seed, remains one hop by default, and independently scores every expanded candidate under all hard filters.

Existing item, token, repetition, compact-rendering, diversity, and empty-pack rules bound this graded approach. Shadow Mode and explicit irrelevant Bad Cases evaluate the initial thresholds; active thresholds remain versioned and cannot be silently changed by Luna or metrics. ADR-0041 defines the separately reviewed initial probable allowance, and ADR-0042 defines the first-version band-score thresholds.
