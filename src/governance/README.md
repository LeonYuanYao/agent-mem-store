# Incremental and full memory governance

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Runs restartable scans that propose and apply evidence-supported changes to durable knowledge.

## Start here

- [scheduling.ts](scheduling.ts)
- [worker.ts](worker.ts)
- [contracts.ts](contracts.ts)
- [decision-policy.ts](decision-policy.ts)
- [page-evidence.ts](page-evidence.ts)

## Flow and collaborators

Scheduling records due obligations and frozen members; worker prepares/checkpoints model pages and applies results; decision-policy checks evidence; page-evidence supplies reviewed cross-page partners.

- [luna/index.ts](../../src/luna/index.ts)
- [quality/duplicates.ts](../../src/quality/duplicates.ts)
- [vault/index.ts](../../src/vault/index.ts)
- [capacity/index.ts](../../src/capacity/index.ts)

## State and side effects

Persists obligations, frozen inputs, checkpoints and action ledger; approved Agent changes write canonical revisions. Related evidence is bounded and must not alter base-page progress. Persisted weekly/monthly names denote responsibilities; current cadence is defined in scheduling.ts.

## Invariants and change risks

Do not advance successful coverage on failure. Preserve Human authority, scope, revision freshness and idempotency. A possibly changing architecture is not retirement evidence. Literal quotes establish provenance, not semantic entailment.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/integration/governance tests/fault/governance tests/unit/scheduling/governance-schedule.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
