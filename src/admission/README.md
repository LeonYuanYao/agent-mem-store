# Durable candidate admission

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Classifies model output before Candidate creation; records why statements were admitted, rejected or isolated.

## Start here

- [audit.ts](audit.ts)

## Flow and collaborators

classifyAdmission / admittedOutput filter distillation and consolidation output; recordAdmissionAudit persists the bounded audit trail.

- [worker/distillation.ts](../../src/worker/distillation.ts)
- [luna/index.ts](../../src/luna/index.ts)
- [candidates/index.ts](../../src/candidates/index.ts)

## State and side effects

Admission audit rows live in runtime SQLite and have their own retention. Sensitive statement text is redacted before recording.

## Invariants and change risks

Session-only and no-memory statements are rejected; uncertain statements are isolated. Task observations are not durable merely because the model labels them long-term. Admission does not grant promotion or Human authority.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/admission-audit.test.ts tests/integration/admission/audit-retention.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
