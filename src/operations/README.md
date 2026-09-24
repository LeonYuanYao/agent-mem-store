# Application operations

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Provides user-facing use cases shared by command and tool surfaces: setup, recall, remembering, lifecycle changes, diagnostics and migration.

## Start here

- [recall.ts](recall.ts)
- [remember.ts](remember.ts)
- [memory-lifecycle.ts](memory-lifecycle.ts)
- [maintenance.ts](maintenance.ts)
- [status.ts](status.ts)

## Flow and collaborators

Start at the file matching the command. project.ts and session-migration.ts manage scope changes; portability.ts owns handoff/backup; quality.ts and knowledge-verification.ts expose quality workflows.

Initialization writes `[adapters].subagents_enabled = false` in machine-local
configuration. Older configurations receive the same default at Hook read time.

- [cli/command.ts](../../src/cli/command.ts)
- [mcp/server.ts](../../src/mcp/server.ts)
- [candidates/README.md](../../src/candidates/README.md)
- [vault/README.md](../../src/vault/README.md)

## State and side effects

Some operations are read-only; others write Vault/runtime/configuration or install model artifacts. Read the selected operation's preview and apply paths before invoking it on installed data.

## Invariants and change risks

Doctor reports recoverable exhausted Luna work as waiting for evidence/cooldown,
and exhausted recovery as actionable. It does not infer network loss from timeout
alone. Explicit retry resets both the fast-retry epoch and recovery allowance.

Doctor also inspects outstanding governance runs: blocked work is a warning and
scheduled retries are informational. `status.governance` includes the safe failure
diagnostic, attempt counts and retry time. `operation retry` accepts a blocked or
retrying governance run ID, supports a zero-write preview, and resumes its frozen
checkpoint without resetting completed coverage or lifetime attempts.

`status.corpus_retention` reports the opt-in archive policy, schema readiness,
remaining excess, pending batch, last execution/error and twelve-hour pressure.
Inspecting it never starts archival or migrates the database.

Keep request validation, preview and authorization consistent across CLI/MCP callers. A status request does not authorize repair. Preserve exact Human assertions, project routing and migration continuity.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/integration/operations tests/contract/cli-operations.test.ts tests/contract/session-project-migration.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
