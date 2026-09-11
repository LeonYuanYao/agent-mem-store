# Current health evaluation

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Computes retrieval/index health from observed failures, recovery evidence and publication state.

## Start here

- [index.ts](index.ts)
- [foreground.ts](foreground.ts)

## Flow and collaborators

inspectForegroundHealth evaluates the recovery window; inspectIndexHealth reports index readiness.

- [operations/maintenance.ts](../../src/operations/maintenance.ts)
- [retrieval/foreground-attempts.ts](../../src/retrieval/foreground-attempts.ts)
- [retrieval/index-coordinator.ts](../../src/retrieval/index-coordinator.ts)

## State and side effects

Reads runtime health and attempt records. Keep diagnosis separate from manual retry, repair or policy changes.

## Invariants and change risks

A historical failure is not permanent degradation. Conversely, an empty or cancelled response is not a successful recovery observation. Preserve logical-request counting and recovery thresholds.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/current-health.test.ts tests/contract/foreground-attempts.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
