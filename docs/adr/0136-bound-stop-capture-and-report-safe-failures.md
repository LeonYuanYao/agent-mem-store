---
status: accepted
---

# Bound Stop capture and report safe failures

## Context

A reported one-second host timeout coincided with a missing Stop disposition.
Historical records cannot prove the exact failed command or slow stage. Isolated
real-entrypoint experiments nevertheless reproduced timeout and missing capture
when Project discovery latency combined with the independently budgeted 750 ms
Inbox lock wait. Unbounded Git discovery also reproduced the symptom on its own.
Normal capture and SQLite writer contention did not reproduce it. Merely raising
the host limit converts some timeouts into capture failures without saving data.

## Decision

Stop gets a two-second host limit, a shared 1,300 ms capture budget, and a 1,450 ms
async-stall watchdog. Read-only Project discovery gets at most 200 ms, aborts its
Git child on expiry, and does not fall back to synchronous registry creation.
The existing sanitized Inbox envelope retains the source directory and Session;
the Worker resolves missing Project identity with that exact Session ID. Explicit
routes therefore remain authoritative. No new queue or model call is introduced.

Validation and serialization move outside the capacity lock. Normal and
body-free capacity are each scanned once under the lock. Stop waits only within
its remaining budget, leaving 100 ms for return. Other callers keep their existing
lock timeout. Atomic publication, sensitivity gates, size limits and idempotency
are unchanged. A persistently unavailable filesystem or lock may still prevent
capture and must be reported honestly.

Owned hooks have an event-specific statusMessage. Internal failures emit a safe
code, stage, elapsed milliseconds and persistence status in systemMessage and
stderr. No exception text, input content, credential, path or extra append-only
diagnostic log is introduced. An interrupted publication is `unconfirmed`;
successful normal and body-free publication remain distinguishable. The watchdog
returns fail-open output before exiting but cannot run during an event-loop stall,
OS suspension, or after a host kill. Codex owns hook trust review.

## Verification

Real child-process tests cover slow Git cancellation and durable deferral,
session-route preservation at import, transient and persistent lock contention,
body-free failure output, and watchdog termination during a stalled write. Tests
use isolated Runtime fixtures, never the installed Vault or Runtime. Historical
incident attribution remains qualified rather than inferred from fault injection.
