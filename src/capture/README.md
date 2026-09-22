# Capture and durable inbox

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Accepts host events and makes them recoverable for background processing without running knowledge extraction in a hook.

## Start here

- [index.ts](index.ts)
- [inbox.ts](inbox.ts)
- [inbox-files.ts](inbox-files.ts)

## Flow and collaborators

prepareCaptureEventForPersistence applies input and sensitivity checks; appendCaptureDisposition persists inbox work; importCaptureInboxBatch imports it; claim/complete/fail functions manage processing.

`deadline.ts` carries optional monotonic capture progress across stages and
renders body-free failure diagnostics. Stop's lock wait uses the remaining total
budget, reserving 100 ms; other callers retain the 750 ms lock-wait limit. Normal
event validation/serialization happens before lock acquisition; normal and
body-free file capacity are each scanned once under the lock. Publication still
requires the existing atomic, synced write. Persistence is `unconfirmed` once a
write begins, not optimistically successful on timeout.

- [adapters/codex/hook.ts](../../src/adapters/codex/hook.ts)
- [worker/evidence.ts](../../src/worker/evidence.ts)
- [runtime/database.ts](../../src/runtime/database.ts)

## State and side effects

Writes runtime inbox files, capture rows, outbox state and body-free diagnostics. Legacy file import is maintained separately in inbox-files.ts.

## Invariants and change risks

Keep event identity and replay idempotency intact. Do not persist raw secrets or expand arbitrary tool input/output capture. The hook path must remain bounded and tolerate worker contention.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/integration/outbox/capture.test.ts tests/fault/capture-inbox.test.ts tests/fault/hook-worker-contention.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
