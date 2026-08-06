---
status: accepted
---

# Use a lexicographic SessionStart ranking key

SessionStart orders eligible dynamic candidates with a strict lexicographic key:

1. effective priority tier;
2. authority;
3. applicability specificity;
4. evidence state;
5. time-sensitive freshness;
6. capped utility; and
7. stable Memory identity.

A later component cannot compensate for a lower earlier component. This is an explainable ordering tuple rather than an opaque weighted sum.

Authority orders Human-authored Memory before explicitly human-confirmed Agent-derived Memory and then before deterministically or semantically validated Agent-derived Memory. Applicability specificity compares only candidates that have already passed hard eligibility and prefers a more exact match to the resolved environment and conditions. Freshness participates only when the Memory is explicitly time-sensitive. Usage and explicit deep-read history remain a small capped utility tie-break. Stable Memory identity produces the final repeatable order.

Current-Project scope affects only the separately accepted one-tier promotion. It receives no second scope preference in this key. Any future addition, removal, or precedence change requires explicit human Review rather than silent tuning by Luna, governance, or runtime metrics.
