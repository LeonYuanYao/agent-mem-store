# Background model adapter and operation state

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Defines structured model requests/responses and invokes the configured Codex subprocess for extraction, consolidation and governance.

## Start here

- [index.ts](index.ts)
- [operations.ts](operations.ts)

## Flow and collaborators

CodexLunaAdapter owns prompt/schema construction, isolated execution and validation. operations.ts owns durable queue claims, leases, retry epochs and health reporting.

`recovery-policy.ts` shares exhausted transient recovery eligibility with Doctor.
After the fast retry budget, ordinary claims allow two single-attempt probes with
a six-hour cooldown and independent healthy-model success evidence. Migration
0061 persists the allowance. Schema/authentication/configuration/local failures
remain explicit-retry-only. See ADR-0138; do not reopen fast retries for a probe.

- [worker/distillation.ts](../../src/worker/distillation.ts)
- [quality/pipeline.ts](../../src/quality/pipeline.ts)
- [governance/contracts.ts](../../src/governance/contracts.ts)

## State and side effects

Spawns Codex and uses isolated runtime work files; operation records live in SQLite. Unit/contract mocks verify protocol behavior, not real-model knowledge quality.

## Invariants and change risks

Keep background calls isolated from workspace instructions, hooks and recursive MemStore capture. Do not silently change model, reasoning or service tier. Preserve schema validation and distinguish invocation failure from a valid empty result.

The exported consolidation output schema also validates the Worker's saved model checkpoint. Its 128-clause model-response bound is distinct from the Worker's final result, which may additionally contain locally restored priority Candidates and is admitted in pages.

## Verification

Extraction/consolidation prompt v7 include a separate retention-value judgment in
the same response. Governance prompt v5 evaluates only requested missing targets
(at most twenty). The shared contract lives in `capacity/retention-value.ts`.
Legacy saved responses without this field remain usable and unassessed. Reasons
are derived ranking metadata, never replacement knowledge or injection text.

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/luna-adapter.test.ts tests/fault/luna-health.test.ts tests/integration/governance/luna-governance-adapter.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
