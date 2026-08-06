---
status: accepted
---

# Page SessionStart candidates without a global cutoff

SessionStart does not load all eligible Memory bodies and does not use a global Top-N candidate cutoff. Completed derived state exposes indexed lifecycle, scope, priority, authority, primary category, applicability, representation readiness, and stable ordering fields.

After resolving the current Project, local code exposes logical candidate buckets by effective priority tier and primary category. Current-Project and Global candidates compete in the same bucket without fixed scope allocation. Each bucket uses deterministic keyset pagination over the accepted lexicographic key.

The first-version configurable page size is 16 lightweight index rows per bucket. Additional pages are read only when duplicate, inapplicable, unavailable, or non-fitting candidates require them. Iteration stops when the accepted item or token limit is reached or every relevant cursor is exhausted. There is no global candidate-count hard limit, so page size changes database round trips and latency but not the final result for identical completed state and budgets.

The Injection Receipt records lightweight rows examined, bucket page counts, filtering and fit outcomes, and the terminal stop reason. Scanning an index row does not require loading its Canonical Memory body.
