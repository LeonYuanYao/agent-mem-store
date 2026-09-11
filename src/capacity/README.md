# Memory space capacity and working sets

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Tracks per-space pressure and selects a bounded recall working set; coordinates capacity obligations separately from ordinary governance coverage.

## Start here

- [index.ts](index.ts)

## Flow and collaborators

inspectMemoryCapacity / reconcileMemoryCapacity track pressure; selectMemoryWorkingSet computes membership; rebalanceMemoryWorkingSet persists changes; publication helpers track index visibility.

- [governance/worker.ts](../../src/governance/worker.ts)
- [retrieval/index-coordinator.ts](../../src/retrieval/index-coordinator.ts)
- [operations/memory-lifecycle.ts](../../src/operations/memory-lifecycle.ts)

## State and side effects

Writes capacity/working-set state in runtime SQLite and triggers index publication requirements. Archive/purge have separate executors and safeguards.

## Invariants and change risks

Working-set exclusion is reversible and does not delete canonical knowledge. Preserve Human/pinned/other protected items and same-space constraints. Do not advance ordinary governance coverage to satisfy capacity work.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/cli-capacity.test.ts tests/integration/operations/memory-working-set.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
