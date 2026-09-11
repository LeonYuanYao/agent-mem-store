# Shared boundary contracts

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Provides result envelopes, atomic file writes, runtime capability checks and local sensitivity classification.

## Start here

- [envelope.ts](envelope.ts)
- [atomic-file.ts](atomic-file.ts)
- [runtime-compatibility.ts](runtime-compatibility.ts)
- [sensitivity.ts](sensitivity.ts)

## Flow and collaborators

successEnvelope / errorEnvelope define command results; atomic write helpers protect file replacement; classifyLocalSensitivity identifies known secret patterns.

- [capture/index.ts](../../src/capture/index.ts)
- [vault/index.ts](../../src/vault/index.ts)
- [cli/command.ts](../../src/cli/command.ts)
- [mcp/server.ts](../../src/mcp/server.ts)

## State and side effects

Most helpers are pure; file helpers and runtime probes perform local I/O. This module does not own domain lifecycle decisions.

## Invariants and change risks

Keep validation at external boundaries. Sensitivity heuristics are not proof that all secrets are detectable. Do not log matched secret values. Preserve exclusive-write and replacement semantics.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/runtime-compatibility.test.ts tests/contract/program-data-separation.test.ts tests/fault/vault-cas.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
