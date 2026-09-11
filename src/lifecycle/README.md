# Archive retention policy

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Centralizes calendar-month archive retention and purge deadline calculation.

## Start here

- [archive-retention.ts](archive-retention.ts)

## Flow and collaborators

archivePurgeAfter computes the deadline; archiveLifecycleDetails records it; loadArchiveRetentionMonths loads policy.

- [governance/worker.ts](../../src/governance/worker.ts)
- [operations/memory-lifecycle.ts](../../src/operations/memory-lifecycle.ts)
- [purge/index.ts](../../src/purge/index.ts)

## State and side effects

Pure deadline helpers plus policy reads. Actual Markdown removal and backup handling are owned by purge.

## Invariants and change risks

Use calendar-month arithmetic rather than a fixed number of days. Retention calculation does not authorize deletion. Restore, protection checks and purge execution remain separate.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/integration/lifecycle/archive-retention-worker.test.ts tests/destructive/purge/ordinary-purge.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
