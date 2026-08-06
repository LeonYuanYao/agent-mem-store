---
status: accepted
---

# Bound SessionStart item and identity counts

The first-version configurable Core Memory Pack item limit is 12 across `startup: always`, dynamic compact, and identity representations. At most four of those items may use identity form. MemStore does not fill either allowance artificially when fewer candidates qualify.

The values 12 and four are conservative initial engineering defaults rather than fixed product invariants. They prevent many very short representations from fragmenting attention after the 1,200-token budget has ceased to be the effective constraint. Shadow Mode records item-limit, identity-limit, and token-budget omissions separately, but Luna, metrics, and governance cannot modify active values without explicit human Review.

`startup: always` has no separate item quota beyond the total item limit, identity limit, and its 600-token content ceiling. Project and Global Memory retain the accepted shared pool without a fixed item ratio.
