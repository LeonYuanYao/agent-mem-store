---
status: superseded-by-0104
---

# Allow reviewed Shadow program continuity

This decision is retained as history. ADR-0104 removes Shadow invalidation and
the `shadow accept-program-change` operation, so executable changes are now
reported as non-blocking observations and continuity needs no acceptance.

An official Shadow window normally invalidates whenever the executable program
identity changes. A user-reviewed change that does not alter the installed
candidate, managed Hooks, MemStore MCP configuration, or approved retrieval
profile may retain the existing observation window through the explicit
`shadow accept-program-change` operation.

The operation requires the exact active window identity and a bounded review
reason. Preview is read-only. Apply verifies the existing baseline digest and
all unchanged identities, then replaces only `programSha256` and appends an
audit record containing the old and new program identities, previous baseline
digest, reason, and acceptance time. A compare-and-swap prevents accepting a
baseline that changed during review.

The operation preserves the window identity, start time, minimum end time, and
all frozen coverage counts. It cannot accept candidate, Hook, configuration, or
retrieval-profile changes and does not manufacture observations or restart the
window.
