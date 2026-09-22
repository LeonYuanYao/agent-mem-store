# Project identity and session routing

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Resolves directories into memory scopes, handles explicit project markers and tracks session-specific project routes.

## Start here

- [index.ts](index.ts)
- [session-route.ts](session-route.ts)

## Flow and collaborators

resolveProject performs discovery; inspectProject reports identity; configureProjectMarker handles explicit configuration. Session routes override routing for a migrated thread.

Read-only `inspectProject` accepts an optional AbortSignal. Cancellation kills
the current Git child and propagates rather than being interpreted as a non-Git
directory or invalid marker. A canceled Hook lookup must not register a new
Project. Background deferred capture resolution receives the original Session ID.

- [adapters/codex/hook.ts](../../src/adapters/codex/hook.ts)
- [operations/project.ts](../../src/operations/project.ts)
- [operations/session-migration.ts](../../src/operations/session-migration.ts)

## State and side effects

Writes project registrations and routing records; explicit marker operations may write .memstore-project. Ordinary discovery must not create an explicit marker.

## Invariants and change risks

Preserve distinctions between Git identity, non-Git registered roots and explicit markers. Submodules inherit the parent project unless explicitly overridden. Do not infer shared identity from a directory name alone without the implemented checks.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/integration/projects/project-resolution.test.ts tests/contract/session-project-migration.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
