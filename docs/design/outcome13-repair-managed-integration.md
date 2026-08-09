# Outcome 13 repair and managed integration

Status: Gate 5 review candidate. Repository-local and uninstalled.

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
Hook events, one MCP server, three Skill links, the notifier, and one Worker
LaunchAgent. It adds no `PreToolUse` Hook, calls no Luna model inline, preserves
native-memory settings, and keeps automatic foreground injection disabled.
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

## Cutover rehearsal and frozen candidate

`config/gate5-shadow-v1.json` freezes E5-base q8, the Hook set, Skill set,
Monday governance cadence, Shadow injection state, native-memory preservation,
and the future single-step cutover flags. The rehearsal changes only isolated
configuration copies: both native generation/use flags become false while the
managed Hook mode becomes active, then an identity-checked rollback restores
the original bytes. Native-memory bodies are not read, imported, moved,
rewritten, or deleted.

## Boundary

Gate 5 evidence uses the current real Codex topology only as read-only input to
an isolated temporary HOME. No real Hook, MCP, Skill, LaunchAgent, notifier,
Vault, Runtime, native-memory setting, or native-memory data is changed. Gate 5
approval is still required before installing this frozen candidate and
starting the official seven-day Shadow window.
