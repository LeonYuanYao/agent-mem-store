# Configuration and hook presentation

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Loads portable Vault policy and machine-bound runtime configuration, validates compatibility and controls injection/display settings.

## Start here

- [index.ts](index.ts)
- [hook-display.ts](hook-display.ts)

## Flow and collaborators

loadConfiguration resolves and validates documents; rememberLastKnownGoodConfiguration supports recovery; hook-display.ts reads display and SessionStart settings.

- [operations/initialize.ts](../../src/operations/initialize.ts)
- [integration/setup.ts](../../src/integration/setup.ts)
- [cli/codex-hook.ts](../../src/cli/codex-hook.ts)

## State and side effects

Reads TOML/configuration documents; explicit activation and last-known-good maintenance can write configuration state. Do not add machine-specific paths to portable policy.

## Invariants and change risks

Keep program, Vault and runtime paths distinct. Failures must not silently select a different Vault. Displaying a hook summary and injecting memory context are separate controls.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/initialization.test.ts tests/contract/runtime-compatibility.test.ts tests/contract/codex-hook-entrypoint.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
