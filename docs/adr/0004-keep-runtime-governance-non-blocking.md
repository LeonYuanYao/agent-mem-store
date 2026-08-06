---
status: accepted
---

# Keep runtime memory governance non-blocking

MemStore performs ordinary capture and governance without interrupting the user's active Coding Agent session. Candidate screening, deduplication, validation, merging, promotion, re-evaluation, rejection, and expiration run automatically in the background. Human review is an exception path: MemStore asks for a decision only when an unresolved, material conflict affects the correctness of the current task, or when the user explicitly opens a review surface.

Candidate states are internal lifecycle states rather than mandatory approval steps or inbox notifications. Low-frequency governance summaries may expose important outcomes and conflicts, but ignoring such a summary must not prevent the system from continuing to operate. ADR-0019 defines an optional, aggregated Human Memory Review Digest and delivery fallback without turning review into a foreground prerequisite.
