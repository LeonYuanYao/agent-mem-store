# Outcome 13 repair and managed integration

Status: implemented and hardened for managed Gate 5 Shadow operation.

## Foreground repair

`src/repair/index.ts` turns a receipt-bound Bad Case into a bounded Repair
Bundle under Runtime Data. The bundle contains diagnostic metadata, receipt and
index identities, schema and program versions, and review templates; it does
not copy Canonical Memory bodies into Git. A user-started GPT-5.6 Session must
record a proposal before Review Gate 1 authorizes exact targets. Application,
replay, and Review Gate 2 are separate events.

Class A and B repairs resolve only after their accepted evidence predicates and
explicit Gate 2 approval pass. Class C enters monitoring and needs seven
consecutive calendar days, 30 relevant safety opportunities, and zero
violations. The `$memstore-repair` Skill orchestrates these core commands but
cannot switch models, edit the Vault as a product repair, install, commit,
push, or resolve a case silently.

## Managed integration

`src/integration/managed.ts` prepares one owned Shadow merge for five Codex
Hook events, one MCP server, three Skill links, the `memstore` CLI, the notifier,
and one Worker LaunchAgent. It adds no `PreToolUse` Hook, calls no Luna model inline, preserves
native-memory settings, and keeps automatic foreground injection disabled.
Managed Hooks use a dedicated lightweight process entrypoint; the stable legacy
CLI Hook route dispatches to the same adapter before loading other CLI modules.
The LaunchAgent explicitly supplies the named Codex home used by Luna, the
approved local-only embedding directory, the Codex executable, and the owned
notifier path. Missing or drifted embedding bytes prevent Worker startup rather
than silently degrading the official Shadow candidate.

Preview performs no mutation. Install rechecks every preview identity, creates
recoverable backups, writes atomically, and records exact before/post ownership.
Repair acts only when a target is either exactly healthy or exactly back at its
recorded pre-install state. Uninstall requires every managed target to match
the expected installed identity before making any change, then restores exact
configuration bytes and removes only owned created surfaces. Vault and Runtime
data are retained.

Legacy managed installations can use `integration upgrade --preview` and then
`integration upgrade` to add the missing CLI. Upgrade first verifies the exact
installation request, reports existing owned-target drift, and requires the new
CLI path to remain absent through apply. Existing drift does not block this
independent addition and is never rewritten. Upgrade does not change Codex
configuration, Hooks, Vault data, Runtime data, or Worker process state.

Worker hardening adds a 30-second coalescing window for ordinary capture events,
immediate SessionEnd flush, and a body-free SessionEnd catch-up only after 24
hours of inactivity. Candidate evaluation is automatically scheduled, while
retention, anomaly evaluation, and six-month Candidate Tombstone cleanup run
once after each completed weekly governance window with a durable completion
marker. `status` and `doctor` expose a stale Candidate pipeline rather than
hiding it behind overall Luna health.

Session consolidation replaces long evidence identities with deterministic
short aliases before invoking Luna, restores exact identities locally, and then
applies the original strict provenance checks. The available alias set includes
both Candidate evidence and evidence cited by importance reasons; unknown or
invented aliases remain retryable schema failures.

## Cutover rehearsal and frozen candidate

`config/gate5-shadow-v1.json` freezes E5-base q8, the Hook set, Skill set,
Monday governance cadence, Shadow injection state, native-memory preservation,
and the future single-step cutover flags. The rehearsal changes only isolated
configuration copies: both native generation/use flags become false while the
managed Hook mode becomes active, then an identity-checked rollback restores
the original bytes. Native-memory bodies are not read, imported, moved,
rewritten, or deleted.

The official Shadow baseline retains its starting retrieval index revision for
audit, but ordinary Durable Memory growth may publish later content revisions.
Continuous identity checks freeze the embedding model, artifact, adapter
version, dimensions, and normalization rather than the mutable content revision.

## Boundary

Gate 5 evidence uses the current real Codex topology only as read-only input to
an isolated temporary HOME. Repository tests and evidence generation do not
change a real Hook, MCP, Skill, LaunchAgent, notifier, Vault, Runtime,
native-memory setting, or native-memory data. Applying an upgrade, restarting
the Worker, or starting a replacement official Shadow window remains a named
live-operation review boundary.
