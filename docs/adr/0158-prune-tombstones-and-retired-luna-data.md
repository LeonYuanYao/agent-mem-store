---
status: accepted
---

# Prune Tombstones and the retired Luna pipeline's data

On 2026-10-28 the runtime database was 845 MB for 254 active and 6 archived
Memories. 8,500 Memories purged on 10-12 remained as body-free Tombstone files
(38 MB Vault, 97% of `Memories/`) and catalog rows. Their text survived elsewhere:
governance checkpoints held full Memory snapshots (1,349, 114 MB), candidates held
the statements and evidence (13,204 candidates, 34,130 evidence rows), compact
quality items held proposed compacts (8,637). Distillation batches, Session
consolidations and Luna operations, retired since dreaming took over, held the
clauses and prompts. Purge removes the body, revisions and index entries only.
Every governance run had completed (last 10-08), every candidate was promoted,
rejected or expired, no Luna operation was pending.

Decision:

- `scripts/prune-retired-data.ts` previews by performing the deletion and rolling
  it back; `--apply --backup DIR` writes a consistent database copy and every
  Tombstone file it removes, deletes in one transaction, removes the files and
  empty folders, optimizes the FTS index and vacuums. The worker is stopped first.
- It removes Tombstones (file, catalog row, receipt items, irrelevant observations,
  quality items, summaries, duplicate clusters, ranking exclusions, closed review
  suggestions, Vault conflicts, relationships, revisions) and the finished Luna
  work: governance actions, applied checkpoints and members of completed runs;
  finished candidates with their assessments, decisions and evidence; completed
  distillation batches with their events; completed consolidations; finished
  Luna operations older than seven days that nothing kept refers to.
- It keeps Memory refs reserved (no M:id is reused), governance runs and
  obligations (cadence), distillation cursors and candidate Tombstones (no replay
  of captured Sessions), capture events (their own retention), dreaming data,
  corpus retention plans (body-free) and any unfinished work. It refuses to run
  while a purge is in progress.
- It is run by hand, like the purge it follows; purge itself is unchanged.

The review SPEC requires before pruning Tombstones: no Memory relationship, no
open governance run, Verification Request or capacity wait, no in-progress purge;
retrieval receipt items naming them are removed with them; Luna replay is off and
its cursors stay. `recall show` of a pruned M:id reports it is not in the catalog
instead of explaining the purge.

Result on 2026-10-28, rehearsed first on a copy of the runtime and Vault: 367,774
rows and 8,500 files removed, database 845 MB to 402 MB, Vault 38 MB to 4.7 MB,
no foreign-key violation, `quick_check` ok, `doctor --deep` healthy with 260
catalog entries validated, the retrieval index republished with 254 Memories, and
recall returning the same results as before.

Rejected: pruning inside purge (purge is the guarded, checkpointed path for one
Memory; this is a one-time cleanup of a retired pipeline); deleting Tombstone files
alone (the catalog would name missing files); deleting capture events (their 30-day
retention already removes payloads, and dreaming reads the recent ones).
