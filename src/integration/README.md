# Installation and managed host integration

[Source map](../../src/README.md) · [Agent guide](../../AGENTS.md)

## Responsibility

Plans and applies installation of hooks, MCP configuration, worker launch settings and supporting assets.

## Start here

- [setup.ts](setup.ts)
- [managed.ts](managed.ts)

## Flow and collaborators

previewFriendlySetup / applyFriendlySetup provide the installer workflow; managed.ts owns manifests, preservation, upgrades, uninstall and native-memory cutover.

- [operations/initialize.ts](../../src/operations/initialize.ts)
- [cli/command.ts](../../src/cli/command.ts)
- [adapters/README.md](../../src/adapters/README.md)

## State and side effects

Writes host configuration and managed files, and can control launch services. Tests must use isolated configuration roots, not the operator's real account.

## Invariants and change risks

Never overwrite unmanaged user configuration merely to make installation pass. Preserve preview-first behavior and divergence detection. Installing, enabling active injection and changing native memory are explicit operations.

`integration upgrade` can update the owned CLI and the notifier executable, Info.plist and signature resources from the supplied built app. It compares current bytes with the ownership manifest before replacement; notifier drift is not adopted silently. This upgrade does not rewrite Hooks, change native memory or restart the Worker. Register the installed bundle with LaunchServices after updating native artifacts and validate notification click behavior separately from delivery.

## Verification

Run from the repository root:

```sh
pnpm exec vitest run tests/contract/friendly-setup.test.ts tests/integration/managed-install/preservation.test.ts tests/fault/managed-install/divergence.test.ts
```

Check these test scenarios before changing behavior.

## Design references

Use [CONTEXT.md](../../CONTEXT.md) for domain vocabulary, [SPEC.md](../../SPEC.md) for product contracts and the [ADR directory](../../docs/adr/) for decision history. Update this guide when responsibilities, state ownership or verification paths change.
