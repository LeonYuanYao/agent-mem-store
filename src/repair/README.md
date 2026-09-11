# Explicit bad-case repair workflow

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Tracks user-initiated irrelevant-retrieval repair proposals, approvals, application evidence and verification.

## Start here

- [index.ts](index.ts)

## Flow and collaborators

prepareRepair creates a bounded bundle; proposal/Gate1/application/replay/Gate2 functions record the workflow; recordSafetyObservation tracks required observations.

- [retrieval/recall.ts](../../src/retrieval/recall.ts)
- [operations/knowledge-verification.ts](../../src/operations/knowledge-verification.ts)
- [runtime/database.ts](../../src/runtime/database.ts)

## State and side effects

Creates repair bundles and audit records. Product-code edits and approval decisions remain explicit actions outside automatic knowledge governance.

## Invariants and change risks

Recording a proposal does not approve applying it. Preserve risk-class and gate requirements; synthetic replay is not a substitute for required live safety observations. Do not implement silent background repairs here.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/e2e/repair/synthetic-irrelevant.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
