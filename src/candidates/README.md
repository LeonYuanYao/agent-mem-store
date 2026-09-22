# Candidate lifecycle and promotion

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Owns candidate identities, evidence-based evaluation, Human assertions, conflicts, expiration and high-value anomaly handling.

## Start here

- [index.ts](index.ts)
- [human.ts](human.ts)
- [retention.ts](retention.ts)
- [anomalies.ts](anomalies.ts)

## Flow and collaborators

createAgentCandidate records a proposal; evaluateCandidate applies promotion rules. Human assertions and conflict resolution have separate entry points.

- [admission/audit.ts](../../src/admission/audit.ts)
- [worker/governance.ts](../../src/worker/governance.ts)
- [vault/index.ts](../../src/vault/index.ts)

## State and side effects

Mutates candidate/evidence/verification rows and can write promoted canonical Markdown. Expiration and tombstone deletion must retain their distinct semantics.

Candidates may carry a versioned retention assessment from extraction. Promotion
copies it into the semantic-input-bound Runtime cache without another model call.
It does not alter promotion gates, Human authority or the canonical body. Old-policy
assessments are ignored and can be supplemented by later governance.

## Invariants and change risks

An Agent-derived statement cannot become Human-authored through model confidence. Candidate admission, corroboration and recall eligibility are separate decisions. Preserve scope, provenance and global authorization checks.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/integration/lifecycle/candidate-lifecycle.test.ts tests/integration/lifecycle/human-assertion.test.ts tests/integration/lifecycle/high-value-anomaly.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
