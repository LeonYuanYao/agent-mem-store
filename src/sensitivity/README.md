# Sensitivity review and retention

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Summarizes captured sensitivity findings and removes expired diagnostic metadata under policy.

## Start here

- [summary.ts](summary.ts)
- [retention.ts](retention.ts)

## Flow and collaborators

summarizeSensitivityFindings prepares bounded summaries; inspectSensitivityStatus reports outstanding findings; runScheduledSensitivityRetention handles expiry.

- [capture/index.ts](../../src/capture/index.ts)
- [contracts/sensitivity.ts](../../src/contracts/sensitivity.ts)
- [review/inbox.ts](../../src/review/inbox.ts)

## State and side effects

Reads/writes sensitivity assessment and retention state in runtime SQLite. The low-level detector belongs to contracts/sensitivity.ts.

## Invariants and change risks

Keep secrets out of summaries and notifications. Metadata cleanup is not approval to reinstate rejected content. Preserve unresolved review obligations and the retention executor's protections.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/integration/sensitivity/retention.test.ts tests/integration/outbox/capture.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
