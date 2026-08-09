# Outcome 12 archive purge prerequisite

Status: review candidate; repository-local, uninstalled, and exercised only in
isolated temporary Vaults.

## Purpose and boundary

Archive purge is the intentionally destructive second stage of Memory removal.
Archive first excludes knowledge from normal recall while keeping it restorable.
Purge becomes eligible only after the resolved retention deadline and removes
the body plus every historical revision and affected derived index. It retains
one permanent, knowledge-free Canonical Tombstone for replay suppression,
identity continuity, successor explanation, and portable migration history.

Outcome 12 does not run against the configured personal Vault. It does not
install or schedule a Worker, choose a backup destination, or weaken the Gate 4
Shadow boundary.

## Strict preview and recovery proof

`purge preview` and `purge run --preview` use the same bounded selection logic
and perform no application-state mutation. A SQLite read-only connection can
create or update its disposable `-shm` coordination page and may leave an empty
`-wal`; tests separately prove that Vault files, the SQLite main database,
non-empty WAL content, backup files, and all other durable state remain
unchanged.

Execution requires a backup root outside both Vault and Runtime. The executor
derives each corresponding Canonical and revision path, verifies the archived
content identity and every revision file identity, and records only paths and
hashes in its checkpoint. A missing or changed backup, ambiguous path, stale
catalog, stale content identity, restored lifecycle, or changed target aborts
before that item is deleted.

External backup retention and deletion remain outside MemStore's guarantee.

## Retention and authority

Resolution is conservative:

- `retain_forever` always protects the body;
- an explicit per-Memory `purge_after` supplies the fixed deadline and may
  override a pin;
- a pin without an explicit purge directive protects the body;
- Human-authored Memory has no automatic physical deletion without an explicit
  directive;
- Agent-derived Memory without a per-Memory directive defaults to six calendar
  months from immutable `archived_at`, including end-of-month calendar rules.

Preview exposes protected identities and reasons without copying knowledge
bodies.

## Checkpoints and agreement

Migration 14 stores one executor run and bounded item checkpoints. Each item
advances through prepared, Tombstone written, revision bodies removed, catalog
committed, derived indexes removed, and completed. Recovery accepts only the
original archived content identity or the exact Tombstone that records that
identity. It rechecks lifecycle and backup state before continuing.

The Tombstone keeps scope, authority, Memory identity, retained revision
identities, archived/purged times, original content hash, reason, and optional
successor identifiers. It clears body, semantic contracts, compact/standard/
identity representations, applicability, importance tags, provenance content,
relationships, and injection receipts. Historical revision files and catalog
rows are removed. Any retrieval index containing the Memory is invalidated and
its vector directory removed; FTS and document rows are deleted. Catalog
rebuild never recreates a Tombstone revision copy.

## Bounded execution and catch-up

The default batch stops after 25 bodies, 16 MiB, or ten seconds of destructive
work. Portable settings may lower those ceilings. Values above 200 bodies,
128 MiB, or 60 seconds are rejected. Full `VACUUM` is never run automatically.

The executor checks durable Capture backlog, active retrieval-index building,
and the foreground-pressure adapter before every item. Reaching a normal batch
boundary schedules the next opportunity no sooner than 30 seconds. Foreground
pressure yields the prepared checkpoint for at least five minutes. No thread
sleeps inside purge; the Worker uses `nextEligibleAt`, so shutdown, sleep, or a
missed wake-up naturally catches up from the same durable checkpoint.

## Public commands

- `memstore purge preview --backup <vault-copy>` is always dry-run.
- `memstore purge run --preview --backup <vault-copy>` is the equivalent
  compatibility form.
- `memstore purge run --backup <vault-copy>` executes one bounded batch and
  returns purged identities, skips, remaining work, and the next eligible time.
- `--bodies`, `--bytes`, and `--duration-ms` can only remain within the reviewed
  maxima.

## Evidence and limitations

`pnpm evidence:purge` runs frozen installation, lint, type-check, focused
destructive tests, the complete test suite, build, production audit, and license
inventory. It snapshots the real Obsidian Memory directories, MemStore
Application Support, Codex configuration/Hooks, Skill links, and LaunchAgent
before and after. The generated machine-local artifact is
`artifacts/evidence/purge.json`.

The managed scheduler, backup configuration, and installation ownership are
Outcome 13 work. The evidence does not claim a real personal-Vault purge or
control over Obsidian Sync, Time Machine, cloud history, or another external
backup.
