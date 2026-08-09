# Core Foundation contracts

Status: Gate 3 candidate.

## Public seams

- Configuration loads and activates the portable policy and machine config as
  one validated pair. Invalid manual edits use a machine-local last-known-good
  pair without overwriting the user's file. A higher schema version returns
  bounded read-only status rather than silently falling back. Supported-version
  unknown fields are preserved, but any top-level key claimed by both documents
  is rejected before activation.
  Portable policy reserves lifecycle, retention, promotion, injection,
  governance, review, anomaly, and Luna-health namespaces. Machine config
  reserves paths, Projects/Git cache, adapters, embedding, Luna, notifier, and
  LaunchAgent namespaces. Inner settings not consumed before Outcome 6 remain
  extensible rather than receiving speculative behavior in Gate 3.
- Project Resolution applies nearest-marker precedence, realpath normalization,
  Git evidence, outermost-submodule inheritance, and deepest non-Git Registry
  roots. Unsafe identity evidence never falls through to a guess.
- Capture accepts a versioned normalized event and returns only after an atomic
  SQLite commit. Duplicate delivery returns the original event identity.
- Canonical Vault creates, revises, reads, and reconciles identity-stable
  Markdown through content-identity compare-and-swap.
- The Gate 3 CLI exposes only initialization. Later CLI and MCP adapters must
  call these seams rather than repeat their behavior.

## Failure contracts

- Codex Hooks always return `continue: true`. When Runtime remains writable, an
  invalid Hook envelope or capture failure also records a body-free aggregated
  health incident. A held SQLite writer lock skips this secondary write so the
  fail-open path remains bounded.
- High-confidence Secret bodies never reach Outbox or Canonical Vault.
  Contextual uncertainty enters body-free Quarantine.
- Final rendered Canonical source is sensitivity-screened before any current or
  immutable Vault file is created. Schema, identity, and recomputed content
  identity are read back before the Runtime catalog advances.
- Missing, reordered, or corrupted Outbox segments fail closed as evidence.
- A stale Vault content identity records a conflict and cannot overwrite the
  observed file.
- An unreconciled Human edit blocks an Agent revision before any Vault write.
  v1 uses a final content recheck plus atomic rename; it intentionally does not
  ship a native content-CAS helper for the remaining narrow race.
- Catalog rebuild recreates a missing immutable current revision from the
  Canonical current note before publishing rebuilt Runtime state.
- Catalog rebuild restores revision links from each revision's portable
  predecessor identity, not from timestamps. Manual reconciliation updates the
  Runtime lifecycle, authority, sensitivity, and relationship projection in the
  same transaction as the revision.
- Initial writes, ordinary revisions, reconciliation, and rebuild all project
  the current outgoing relationships into `memory_relationships`.
- An acknowledged Outbox commit survives immediate process termination; replay
  of its deduplication key returns the original event identity.
- Applied SQLite migration source checksums are immutable.
- Same-basename Git repositories without sufficient origin/common-directory
  evidence remain unresolved until an explicit marker selects an identity.

## Gate 3 evidence

`pnpm evidence:gate3` runs the frozen install, lint, strict typecheck, complete
test suite, build, production dependency audit, and production license inventory.
It writes the reproducible result to ignored `artifacts/evidence/gate3.json`,
including the exact HEAD, tracked-diff hash, every tracked or untracked source
path and hash, a claim-to-test map, known risks, and before/after machine-effect
snapshots. The evidence run neither installs adapters nor accepts a real Vault
or Runtime path.

## Identities and time

- Project markers use `msproj_` plus lowercase UUID v4.
- Runtime operation identities use a type prefix plus UUID.
- Persisted timestamps are RFC 3339 UTC strings.
- SQLite payload integrity uses SHA-256. Secret deduplication uses a machine
  local HMAC key stored with mode `0600`.
