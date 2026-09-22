# Configuration and hook presentation

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Loads portable Vault policy and machine-bound runtime configuration, validates compatibility and controls injection/display settings.

## Start here

- [index.ts](index.ts)
- [hook-display.ts](hook-display.ts)

## Flow and collaborators

loadConfiguration resolves and validates documents; rememberLastKnownGoodConfiguration supports recovery; hook-display.ts reads display and SessionStart settings.

`[adapters].subagents_enabled` defaults false. Every Hook reads it before capture
and retrieval; missing or invalid configuration keeps subagents disabled. This
machine-local setting does not disable explicit MCP/Skill operations or change
Codex native memory configuration.

- [operations/initialize.ts](../../src/operations/initialize.ts)
- [integration/setup.ts](../../src/integration/setup.ts)
- [cli/codex-hook.ts](../../src/cli/codex-hook.ts)

## State and side effects

Reads TOML/configuration documents; explicit activation and last-known-good maintenance can write configuration state. Do not add machine-specific paths to portable policy.

jev.ts reads the optional machine-local `[jev]` settings (disabled by default,
threshold 0.5, at most 600 ms) and credentials from `JEV_MODEL_API_KEY` or the
owner-only `<runtime>/secrets/jev-api-key` regular file. It never sources shell
configuration. Missing or invalid optional settings and unavailable credentials
leave local retrieval usable. Do not put credentials in TOML or portable Vault
policy. The foreground worker re-reads these settings when it has a nonempty pack.

## Invariants and change risks

Keep program, Vault and runtime paths distinct. Failures must not silently select a different Vault. Displaying a hook summary and injecting memory context are separate controls.

Hook summaries show the event, memory count and token count without repeating Memory IDs. Full display preserves the original body, including each item's ID and order; model context delivery is unchanged.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/initialization.test.ts tests/contract/runtime-compatibility.test.ts tests/contract/codex-hook-entrypoint.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
