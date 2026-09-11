# Machine-local database

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Opens the SQLite runtime database, applies migrations when requested, and configures access for readers and writers.

## Start here

- [database.ts](database.ts)

## Flow and collaborators

openRuntimeDatabase is the normal writable entry; openRuntimeDatabaseReadOnly is the read-only entry. Schema changes are in migrations/ at repository root.

- [operations/portability.ts](../../src/operations/portability.ts)
- [capture/index.ts](../../src/capture/index.ts)
- [worker/main.ts](../../src/worker/main.ts)

## State and side effects

Owns connection/migration mechanics, not business state transitions. Transactions are owned by callers; review their boundaries when changing connection behavior.

## Invariants and change risks

Do not treat the runtime database as disposable cache: it contains pending work and audit state. Avoid long write transactions and accidental schema mutation on read-only paths. Back up a live database through supported operations rather than copying only its main file.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/runtime-compatibility.test.ts tests/fault/worker-idle-lock.test.ts tests/fault/recovery/runtime-backup.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
