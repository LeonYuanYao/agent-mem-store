# Post-Cutover Foreground Reliability Implementation Evidence

Status: ready for Implementation Evidence Review on 2026-08-26. Activation is not authorized.

## Reviewed source state

- Base commit: `reliability-baseline-2026-08-26`
- Branch: `main`, one pre-existing commit ahead of `origin/main`
- Implementation state: uncommitted working-tree diff; no commit or push was authorized
- Migration 0050 SHA-256: `650a13ebd312e6413e3dee5ee035fbf1f470f61e5c1b6c87a1aaf73f6feb57eb`
- Migration 0051 SHA-256: `11cfc7d828136f39cc5bb51da8fac55bde328cfa2989a31a2484ad3d9350058b`
- Isolated candidate `dist` tree SHA-256 manifest: `bf2fab80f81fb923829d8b4919739fa3d24110e6558a0778977a6b0fa87a80eb`
- Current installed `dist` tree SHA-256 manifest: `7abe78d238016f3351337248da194816d30317a14fae345407820ec013b02d25`

The LaunchAgent points directly at this checkout's ignored `dist/`. An ordinary repository build briefly replaced those files during evidence work. The issue was detected before any Worker restart or migration, and `dist/` was rebuilt from the base commit and restored. PID `38789` retained its original 2026-08-25 18:32:41 start time. No new source was activated. Temporary build and restoration directories were moved to the macOS Trash after verification.

## Implemented outcome

The repository implementation now provides:

- a normal Capture Inbox ingress that is durable before SQLite import, bounded to 2,048 files and 512 MiB, owner-only, checksummed, Secret-body-free, batch-imported, and compatible with existing version-one pending files;
- protocol-v2 automatic retrieval with a client deadline, one admitted request, zero queue, immediate `busy`, disconnect cancellation, cooperative checkpoints, a 50-millisecond final Receipt transaction, and no Receipt or Context Epoch token increment after cancellation;
- a validated immutable Retrieval Snapshot with revision-bound documents, vectors, relationships, Project/Global scope indexes, and precomputed SessionStart buckets;
- one production worker thread that owns the resident E5 adapter, foreground socket, query priority, batch-16 background document embedding, Snapshot publication, and 1/5/30-second restart backoff;
- a body-free `foreground_attempts` ledger, exactly-once foreground reservation independent of Capture import timing, a 1,024-message persistence bound with time-bucket overflow aggregation, 30-day bounded retention, and status/doctor visibility;
- generation-triggered index coordination with configurable 30-second quiet and 120-second maximum-staleness defaults, foreground-pressure yielding, one build lease, five-minute failure cooldown, and at most one follow-up generation;
- immutable Canonical revision reads, explicit embedding batches of at most 16, revision-scoped FTS staging, a short active-index pointer transaction, and bounded retired-revision cleanup.

The public Capture Module is `src/capture/inbox.ts`. The old `src/capture/emergency-spool.ts` name is removed; the private `src/capture/inbox-files.ts` helper isolates the legacy file codec rather than keeping a pass-through compatibility API.

## Fresh repository evidence

The final evidence run must retain the exact command output in the review transcript. The latest complete run before this document was written reported:

- `pnpm test`: 90 files and 342 tests passed;
- `pnpm typecheck`: passed;
- `pnpm lint`: passed;
- `git diff --check`: passed;
- isolated TypeScript build: passed without writing the installed `dist/`;
- production worker-thread probe with the installed local E5 artifact: thread id 1, 768 dimensions, approved adapter identity, and clean close;
- active Hook benchmark against the isolated candidate build with 10 SessionStart plus 10 UserPromptSubmit samples: SessionStart p95 99.96 ms, UserPromptSubmit p95 119.34 ms, both below the 300 ms warm target and 1,000 ms hard deadline;
- production thread plus real local E5 probe: 1,340.22 ms cold readiness, thread id 1, 768 dimensions, process RSS increased from 58,966,016 to 1,065,680,896 bytes after one query, with 1.87 CPU-seconds user and 0.39 CPU-seconds system during cold load plus probe. This is process-wide fresh-load cost, not steady-state incremental thread overhead.

The isolated old-versus-new failure reproduction reported:

| Path | Client result | Server cleanup | Post-deadline work |
|---|---|---:|---:|
| Legacy non-cancelling fixture | client abandoned at 50.19 ms | 19,702.30 ms | 19,652.30 ms |
| Deadline-owned lane | `deadline_exceeded`; concurrent request `busy` | bounded embedding completed, then stopped | 37.80 ms |

The same evidence run imported one Capture event while SQLite was held, with zero remaining files, and advanced 100 catalog changes from generation 0 to generation 100 with no follow-up due.

## Read-only live baseline

The live program was inspected with the restored pre-implementation build. No repair or mutation command was run.

- Worker PID: `38789`; CPU 0.0%; RSS ranged from 104,496 KiB before model activity to 749,600 KiB after later activity; LaunchAgent and process start time remained unchanged.
- Luna: healthy; 2 pending operations; 0 blocked.
- Active index: `msindex_28a9993e-11c0-4f8d-a254-821257bb9b4b`; 4,018 documents; approved E5 q8 adapter identity.
- Capture: 97 unbatched events; 13 legacy pending files; 2 quarantined files.
- Doctor: degraded only because the legacy emergency-spool check sees pending/quarantined files; SQLite integrity is `ok`.
- Foreground socket: owner-only and present at the existing path.

These values are a baseline, not migration evidence. The 0050/0051 migrations have not been applied to the live Runtime, and the live Worker has not loaded repository changes.

## Activation package — prepared but not executed

The later Activation Review should freeze a timestamp as `<activation-id>` and execute the following reviewed sequence only after explicit approval.

1. Build to an isolated directory, run the full verification set, and record the relative-file manifest hash. Do not use the live checkout's `dist/` as the build output.
2. Create a SQLite backup copy with `node:sqlite`'s backup interface at:
   `<runtime-root>/backups/<activation-id>/state/memstore.sqlite`.
3. Copy the currently installed `dist/` to:
   `<runtime-root>/backups/<activation-id>/program/dist`.
4. Verify that copied program tree against the pre-activation manifest hash. The current source manifest is `7abe78d238016f3351337248da194816d30317a14fae345407820ec013b02d25`; it must be recomputed immediately before activation.
5. Apply migrations 0050 and 0051 only to the SQLite backup copy first by opening its isolated Runtime root with the new `openRuntimeDatabase`; run `PRAGMA integrity_check`, schema checks, status, doctor, and pending version-one Inbox import compatibility there.
6. Replace the installed `dist/` atomically with the already verified isolated build.
7. Restart the same LaunchAgent once:
   `launchctl kickstart -k gui/$(id -u)/com.leonyuanyaoyao.memstore.worker`.
8. Verify the PID changed once, the socket is mode `0600`, exactly one managed Worker and one resident model owner exist, migrations 0050/0051 match the reviewed hashes, the active Snapshot matches the active index, Capture Inbox age decreases, and active SessionStart/UserPromptSubmit probes remain below one second.

The backup artifact and its final SHA-256 are intentionally absent now: creating the official activation backup and recording it in the live Runtime would exceed repository-local authorization. Their presence and exact hashes are an Activation Gate prerequisite, not something this implementation silently fabricates.

## Rollback package

Rollback does not remove migrations or Capture files.

1. Stop new replacement work by restoring the verified program backup atomically from:
   `<runtime-root>/backups/<activation-id>/program/dist`.
2. Restart the same LaunchAgent once with the `launchctl kickstart -k` command above.
3. Verify the restored program manifest, one Worker PID, owner-only socket, Capture progress, SQLite integrity, and unchanged Vault identities.
4. Leave additive tables 0050/0051 in place. The previous program ignores them. Leave normal version-one Inbox files readable; body-free disposition files remain pending and owner-only.

Immediate rollback remains required for wrong-Project or Secret injection, Capture loss, a one-second client deadline breach, repeated thread crash, Receipt/Context Epoch inconsistency, active-index corruption, or failure to restore the socket after one controlled restart.

## 24-hour observation template

Record natural and isolated opportunities separately:

| Window | Kind | Opportunities | Completed | Empty | Busy | Deadline | Cancelled | Unavailable/failed | Max post-deadline ms | Capture loss | Wrong Project/Secret | Index builds/follow-ups | CPU/RSS notes |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 0–3 h | natural | | | | | | | | | | | | |
| 0–3 h | isolated | | | | | | | | | | | | |
| 3–12 h | natural | | | | | | | | | | | | |
| 12–24 h | natural | | | | | | | | | | | | |

Implementation Evidence Review approval authorizes only the separately reviewed Activation package. It does not authorize commit, push, migration, installed-program replacement, Worker restart, or live activation by itself.
