---
status: accepted
---

# Rotate categories within each SessionStart tier

Dynamic SessionStart pack selection first collapses semantic duplicates and materially overlapping renditions of the same claim to the highest-ranked eligible representative. Duplicate wording cannot gain another category slot.

Selection processes effective priority tiers strictly in `critical`, `strong`, then `normal` order. A fitting higher-tier candidate is not omitted merely to admit a different category from a lower tier.

Within one tier, selection rotates deterministically across represented knowledge categories. The first round may take the highest-ranked fitting candidate from each category, the second round may take one more from each category, and later rounds repeat until the token or item limit is reached. Each category queue follows the accepted lexicographic ranking key.

When no other category in the tier has a fitting candidate, one category may continue consuming available capacity; the algorithm does not reserve empty category slots. The separately bounded `startup: always` area does not participate in dynamic-category rotation.
