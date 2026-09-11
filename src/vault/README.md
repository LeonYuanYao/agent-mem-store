# Canonical Markdown and revision history

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Owns canonical Memory files, portable project metadata, revision identity, manual-edit reconciliation and catalog synchronization.

## Start here

- [index.ts](index.ts)

## Flow and collaborators

writeCanonicalMemory performs guarded writes; readCanonicalMemory / readCanonicalRevision read current/history; reconcileCanonicalMemory detects edits; rebuildCanonicalCatalog supports rebuilds.

- [runtime/database.ts](../../src/runtime/database.ts)
- [quality/enqueue.ts](../../src/quality/enqueue.ts)
- [operations/portability.ts](../../src/operations/portability.ts)
- [purge/index.ts](../../src/purge/index.ts)

## State and side effects

Writes Markdown, revision history, portable catalogs and runtime catalog/index-dirty state. Never bypass these paths with ad hoc SQL to change canonical content.

## Invariants and change risks

Human edits retain authority and provenance. Revision writes require predecessor and content-identity checks. Reject secret content and invalidate affected derived representations after changes. The Vault is canonical; SQLite indexes are derived views.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/integration/vault/canonical-memory.test.ts tests/fault/vault-cas.test.ts tests/e2e/portability/vault-handoff.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
