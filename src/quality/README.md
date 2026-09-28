# Representation quality and duplicate assessment

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Maintains compact representations and discovers/reviews duplicate or subsumption relationships.

## Start here

- [pipeline.ts](pipeline.ts)
- [enqueue.ts](enqueue.ts)
- [duplicates.ts](duplicates.ts)

## Flow and collaborators

enqueueCompactQualityRecord schedules changed revisions; runNextMemoryQualityStep generates/validates representations; discoverDuplicateClusters and runNextDuplicateAssessment maintain reviewed pairs.

- [luna/index.ts](../../src/luna/index.ts)
- [vault/index.ts](../../src/vault/index.ts)
- [governance/worker.ts](../../src/governance/worker.ts)

## State and side effects

Reads canonical revisions/index documents, invokes model adapters and persists quality/duplicate jobs. Successful representation changes can require index refresh.

## Invariants and change risks

Similarity alone does not authorize merging. Duplicate conclusions are tied to both revisions and become stale after edits. Structural validity and semantic fidelity are distinct checks; preserve conditions and negations.

Compact and duplicate jobs use the shared background model retry policy. Each
item retains its own budget even when a batch contains jobs with different retry
histories. Successful Compact generation starts a fresh validation budget;
recovery of failed validation reuses its saved draft. Lifetime attempts remain
intact. A valid negative or uncertain assessment is a completed model response,
not a transport failure eligible for connection recovery. See
[ADR-0143](../../docs/adr/0143-unify-background-model-retry-policy.md).

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/integration/lifecycle/memory-quality-pipeline.test.ts tests/integration/lifecycle/memory-duplicate-clusters.test.ts
pnpm exec vitest run tests/integration/operations/model-recovery-worker.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
