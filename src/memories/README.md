# Memory categories and representations

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Defines shared category vocabulary, compact checks and portable numeric reference resolution.

## Start here

- [categories.ts](categories.ts)
- [reference.ts](reference.ts)
- [representations.ts](representations.ts)
- [priority.ts](priority.ts): shared canonical importance tier for indexing and corpus retention.

## Flow and collaborators

selectPrimaryCategory / mapLegacyCategory handle taxonomy; formatMemoryReference / resolveMemoryReference handle M: references; assessExactCompact checks an exact representation.

- [vault/index.ts](../../src/vault/index.ts)
- [operations/category-migration.ts](../../src/operations/category-migration.ts)
- [retrieval/recall.ts](../../src/retrieval/recall.ts)

## State and side effects

Category/formatting helpers are pure; reference resolution reads runtime mappings. Avoid embedding current data counts or machine-specific references in code.

## Invariants and change risks

A display reference is not the canonical UUID or revision identity. Preserve stable identity through migrations. Category mapping and compact structural checks do not establish semantic truth.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/category-migration.test.ts tests/contract/progressive-recall.test.ts tests/integration/lifecycle/memory-quality.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
