---
status: accepted
---

# Start with two probable items and compare in Shadow Mode

The first-version configurable initial limit for a UserPromptSubmit Relevant Memory Pack is two `probable` items, at most 96 rendered tokens each and at most 192 rendered tokens in total. A `high` candidate that fits the pack cannot be displaced by `probable`, the allowance is never filled artificially, and a probable-only pack labels itself as possibly relevant historical reference.

The value two is a conservative MemStore engineering heuristic rather than an industry standard or publicly established optimum. It bounds uncertain attention anchors inside the existing six-item and 1,024-token pack while still allowing more than one possible knowledge direction and preserving identity-based deep reading.

Before Controlled Cutover, Shadow Mode compares `max_probable_items` values 0, 1, 2, and 3 under the same workload. It reports how often probable items are explicitly deep-read, reported irrelevant, displace a high item, improve necessary-memory recall or task outcome, add rendered tokens, or duplicate another item.

The active value remains versioned configuration. Shadow Mode, Luna, metrics, and scheduled governance may recommend a change with evidence but cannot apply it. Any change from the initial value two requires explicit human Review.
