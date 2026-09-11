# Archive body deletion

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Executes due archive-body cleanup and explicit single-memory purge with safety rechecks and recoverable backup state.

## Start here

- [index.ts](index.ts)

## Flow and collaborators

previewArchivePurge / previewSingleMemoryPurge describe effects; runArchivePurgeBatch and applySingleMemoryPurge perform them; runScheduledArchiveRetention drives automatic maintenance.

- [lifecycle/archive-retention.ts](../../src/lifecycle/archive-retention.ts)
- [vault/index.ts](../../src/vault/index.ts)
- [operations/memory-lifecycle.ts](../../src/operations/memory-lifecycle.ts)

## State and side effects

Deletes eligible canonical bodies and updates runtime tombstones, obligations and backup manifests. Use test-owned temporary Vaults; never run destructive tests against installed data.

## Invariants and change risks

Archive, working-set exclusion and body deletion are different operations. Recheck current lifecycle, protections and backup/recovery conditions immediately before deletion. Preserve bounded batches, yield behavior and crash recovery.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/destructive/purge
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
