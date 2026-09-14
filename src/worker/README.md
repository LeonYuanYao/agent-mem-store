# Background work orchestration

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Drives capture import, distillation, candidate processing, quality, governance, retention, indexing and reminders.

## Start here

- [main.ts](main.ts)
- [distillation.ts](distillation.ts)
- [evidence.ts](evidence.ts)
- [recovery-policy.ts](recovery-policy.ts)

## Flow and collaborators

runWorker loops over runWorkerOnce. distillation.ts seals batches and consolidates sessions; governance.ts evaluates Candidates; candidate-maintenance.ts, human-conflicts.ts and session-catchup.ts handle their queues.

- [capture/README.md](../../src/capture/README.md)
- [luna/README.md](../../src/luna/README.md)
- [governance/README.md](../../src/governance/README.md)
- [retrieval/README.md](../../src/retrieval/README.md)

## State and side effects

Owns scheduling order and adapter composition, not a second copy of each domain's rules. Worker governance.ts handles Candidates; src/governance handles durable-memory scans.

## Invariants and change risks

Keep idle iterations low-write and protect foreground work. Open long-running turns are not automatically actionable batches. Respect leases, retry times and idempotency; success must follow persisted completion.

Consolidation checkpoints the validated model output and structured input hash in `session_consolidations.result_json` before admission. Retries reuse this result and replay idempotent Candidate ingestion in pages of at most 64. Advance the Session cursor only after all pages persist; then replace the checkpoint with the final admitted output. A long Session has no 64-Candidate total ceiling.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/fault/worker-idle-lock.test.ts tests/fault/worker-loop-recovery.test.ts tests/fault/luna-worker.test.ts tests/e2e/distillation.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
