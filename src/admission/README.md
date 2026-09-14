# Durable candidate admission

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Classifies model output before Candidate creation; records why statements were admitted, rejected or isolated.

## Start here

- [audit.ts](audit.ts)

## Flow and collaborators

classifyAdmission / admittedOutput filter model output; admittedConsolidationPages applies the same rules to Session output in pages of at most 64. recordAdmissionAudit persists one bounded audit trail for the whole operation.

- [worker/distillation.ts](../../src/worker/distillation.ts)
- [luna/index.ts](../../src/luna/index.ts)
- [candidates/index.ts](../../src/candidates/index.ts)

## State and side effects

Admission audit rows live in runtime SQLite and have their own retention. Sensitive statement text is redacted before recording.

## Invariants and change risks

Session-only and no-memory statements are rejected; uncertain statements are isolated. Task observations are not durable merely because the model labels them long-term. Admission does not grant promotion or Human authority.

The 64-Candidate distillation limit remains enforced. Consolidation can span many Batches and restore omitted priority Candidates; its total is not limited to 64. Preserve all qualifying clauses through paged ingestion.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/admission-audit.test.ts tests/integration/admission/audit-retention.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
