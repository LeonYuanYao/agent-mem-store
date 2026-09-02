---
status: accepted
---

# Install through a preview-first friendly setup

MemStore exposes `./install.sh` as the repository entrypoint and `memstore setup`
as the application entrypoint for a first macOS installation. Both default to a
zero-write preview of user configuration, Canonical Memory, and machine Runtime;
`--apply` is required to install. The shell entrypoint owns only prerequisite
checks and reproducible JavaScript, TypeScript, and notifier builds. The
TypeScript setup operation owns path discovery, model preparation, managed
integration, cutover, Worker activation, readiness verification, and structured
results.

Setup defaults Runtime data to `~/Library/Application Support/MemStore` and
selects exactly one Obsidian Vault: the single open Vault, or the only registered
Vault. It refuses to guess when multiple Vaults are equally eligible. An absent
Codex `hooks.json` is a supported first-install state; preview stays read-only,
install creates the minimal document, and uninstall restores absence. Existing
Hook symlinks are preserved by applying cutover to their real managed target.

Active injection is the friendly default, with `--mode shadow` retained as an
explicit alternative. Active preview requires explicit existing Codex native
memory booleans so the reversible cutover can restore their exact prior values.
Cutover never reads, imports, moves, or deletes native memory data. The reviewed
setup plan is applied in the order: verify or download E5, apply owned managed
surfaces in Shadow mode, bootstrap or restart the LaunchAgent, wait for the
foreground socket, activate injection when requested, then request notification
permission. Model or preflight failure occurs before managed configuration
writes. A later Worker failure is reported as a recoverable partial installation
rather than success; rerunning the same setup command resumes that owned partial
installation after the underlying issue is fixed.

A matching active cutover is an idempotent setup state. Setup verifies the
recorded target hashes, preserves the existing rollback manifest, and does not
create a second cutover. A mismatch remains explicit divergence and is never
accepted as an upgrade or repair baseline.

An older owned installation may adopt its current Active baseline only when the
MCP binding, every managed Active Hook recipe, disabled native-memory flags, and
all unrelated owned targets still match the current contract. Adoption writes
fresh uninstall backups and ownership/cutover manifests but preserves current
Codex config and Hook bytes. Unknown managed changes are treated as divergence.

Notification denial is non-fatal and remains explicit in the result. Worker
readiness is mandatory. Deep Doctor checks the foreground socket whenever an
installed ownership manifest exists, so an installed-but-inactive Worker cannot
appear healthy. JSON setup keeps build progress on stderr and reserves stdout for
one result envelope.

The first friendly release remains checkout-bound: generated entrypoints use the
reviewed repository and Node executable paths. The README therefore requires a
stable clone location. Copying versioned program artifacts into an independently
managed application root and atomic self-update are later distribution work, not
hidden behavior in this installer.
