---
status: accepted
---

# Retire full-history FTS before explicit compaction

Lexical recall reads only `active_fts_memories`, which is atomically rebuilt
for the selected retrieval revision. The earlier `fts_memories` virtual table
has no retrieval reader and accumulated historical index publications. On the
observed Runtime it occupied about 5.3 GiB while the active lexical index used
about 10 MiB.

Migration 0045 drops the retired full-history FTS table and Archive purge no
longer addresses it. The active FTS, retrieval documents, vector sidecars,
receipts, and Canonical lifecycle cleanup remain unchanged.

Physical file reclamation is an explicit user-authorized maintenance action,
not scheduled governance. Writers are quiesced, a compact database is produced
with `VACUUM INTO`, the new file is integrity-checked, and the original database
is retained until the compact replacement has opened successfully and the
Worker, Shadow, and retrieval state are verified.
