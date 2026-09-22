# Memory space capacity and working sets

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Tracks per-space pressure and selects a bounded recall working set; coordinates capacity obligations separately from ordinary governance coverage.

## Start here

- [index.ts](index.ts)
- [corpus-retention.ts](corpus-retention.ts) (repository-local, opt-in preview and explicitly authorized archival)
- [retention-value.ts](retention-value.ts) (shared model contract and effective priority)
- [retention-cache.ts](retention-cache.ts) (semantic-input-bound Runtime assessments)

## Flow and collaborators

inspectMemoryCapacity / reconcileMemoryCapacity track pressure; selectMemoryWorkingSet computes membership; rebalanceMemoryWorkingSet persists changes; publication helpers track index visibility.

- [governance/worker.ts](../../src/governance/worker.ts)
- [retrieval/index-coordinator.ts](../../src/retrieval/index-coordinator.ts)
- [operations/memory-lifecycle.ts](../../src/operations/memory-lifecycle.ts)

## State and side effects

Writes capacity/working-set state in runtime SQLite and triggers index publication requirements. Archive/purge have separate executors and safeguards.

## Invariants and change risks

Working-set exclusion is reversible and does not delete canonical knowledge. Preserve Human/pinned/other protected items and same-space constraints. Do not advance ordinary governance coverage to satisfy capacity work.

Corpus retention has a separate interface and policy. Its preview is read-only;
application requires the exact unexpired preview and explicit capacity authorization.
It archives through canonical revisions, retains Agent authority, and uses the
existing restore and purge policy. `[corpus_retention].mode` defaults to `off`;
`preview` records proposals and `apply` enables bounded, resumable archival without
model work. Pressure episodes continue to target; protected or recent knowledge
can leave excess unresolved. CLI `capacity corpus` and status expose this separate
policy. See the [implementation/activation plan](../../docs/design/economical-corpus-retention-implementation-plan.md)
for conservative activity handling and remaining activation requirements.

Corpus selection orders eligible entries by effective retention value before the
existing priority/activity tie-breaks. Unknown values rank with normal, and high
values remain eligible. Cache writes recheck canonical content and catalog identity;
a content/policy match is reused without refreshing assessment time. Read-only
previews support older Runtime schemas without the cache table. Foreground
retrieval and working-set ranking do not consume this signal.

Optional `active_limit` / `active_headroom` selects aggregate fixed capacity,
counts Human entries, disables project corpus quotas and the cold cutoff, and
preserves all hard protections. Canonical admission is enforced by
`vault/active-capacity.ts`; the corpus module owns reversible reclamation only.
Status includes all-Active counts, pending admissions and waiting Candidates.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/cli-capacity.test.ts tests/integration/operations/memory-working-set.test.ts
pnpm exec vitest run tests/integration/operations/corpus-retention.test.ts tests/integration/lifecycle/candidate-lifecycle.test.ts
pnpm exec vitest run tests/integration/operations/retention-value.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
