# MCP interface

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Exposes supported recall and memory lifecycle operations through the Model Context Protocol.

## Start here

- [main.ts](main.ts)
- [server.ts](server.ts)

## Flow and collaborators

main.ts starts the stdio service; createMemStoreMcpServer registers tools and delegates to operations.

- [operations/recall.ts](../../src/operations/recall.ts)
- [operations/memory-lifecycle.ts](../../src/operations/memory-lifecycle.ts)
- [contracts/envelope.ts](../../src/contracts/envelope.ts)

## State and side effects

Transport itself does not own memory policy. Tool calls may read indexes, record receipts/feedback or explicitly mutate lifecycle through shared operations.

## Invariants and change risks

Keep stdout protocol-clean. CLI and MCP must share scope resolution, approval requirements and result semantics. A read-only tool annotation must match actual effects; preview must not mutate knowledge.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/mcp/tools.test.ts tests/contract/mcp/parity.test.ts tests/contract/mcp/stdio.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
