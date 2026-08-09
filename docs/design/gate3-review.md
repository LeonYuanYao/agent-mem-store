# Gate 3 Core Foundation review

Status: approved by the user on 2026-08-07. This historical review did not
authorize installation or Gate 4 work; later Outcome 6 changes have separate
review evidence.

## Claim-to-evidence map

| Claim | Executable evidence |
| --- | --- |
| Initialization preview is zero-mutation and rerun is idempotent | `tests/contract/initialization.test.ts`, `tests/contract/cli-init.test.ts` |
| Invalid configuration recovers from machine-local last-known-good state; newer schema is recognized before v1 ownership checks and remains read-only; overlapping policy/machine keys are refused | `tests/contract/initialization.test.ts` |
| Project identity is conservative across markers, Git clones, missing origins, non-Git roots, and submodules | `tests/integration/projects/project-resolution.test.ts` |
| Hook capture is fail-open under a held SQLite writer lock and remains under 500 ms; writable failures leave body-free health incidents | `tests/contract/codex-hook.test.ts` |
| Captures are segmented, bounded, deduplicated, replayable, retryable, dead-lettered, and remain durable after immediate post-acknowledgement process termination | `tests/integration/outbox/capture.test.ts`, `tests/fault/outbox-replay.test.ts` |
| Secret and uncertain bodies do not enter Outbox or Canonical Memory, including when an immutable revision must be recovered | `tests/integration/outbox/capture.test.ts`, `tests/integration/vault/canonical-memory.test.ts` |
| Canonical writes preserve compatible unknown fields recursively, compute portable owned-content identity separately from raw-file CAS, read back identity before catalog advance, enforce Human actor authority, immutable scope and predecessor links, synchronize metadata/relationships, strip unknown owned content from knowledge-free Tombstones, and rebuild | `tests/integration/vault/canonical-memory.test.ts`, `tests/fault/vault-cas.test.ts` |
| Runtime compatibility includes WAL, foreign keys, FTS5, backup, and migration checksum refusal | `tests/contract/runtime-compatibility.test.ts` |
| Program code has no installed user/global targets | `tests/contract/program-data-separation.test.ts` |

`pnpm evidence:gate3` records command results, production audit and license
inventory, exact HEAD and tracked-diff identity, a cryptographic manifest of all
tracked and untracked review sources, the claim-to-evidence map, known risks,
and before/after summaries of the reviewed real-Vault and global-integration
targets in ignored `artifacts/evidence/gate3.json`.

## Known bounded risks

- Node 22.17 marks `node:sqlite` experimental even though the required WAL,
  foreign-key, FTS5, and backup behavior passes on the pinned runtime.
- A filesystem does not provide a portable content-hash compare-and-rename
  primitive. The reviewed v1 decision is to avoid native CAS machinery:
  unreconciled Human edits stop Agent writes before mutation, then MemStore
  rechecks content immediately before atomic rename. A non-cooperating editor
  can still race in the remaining system-call window; this accepted bounded risk
  is revisited only if observed Bad Cases justify the maintenance cost.
- Native dependency build scripts for future embeddings were not activated.
  Embedding model execution is Gate 4 work and is not claimed by this review.
- Luna, lifecycle promotion, retrieval/injection, MCP, governance, notifier,
  Skills, Shadow Mode, and installation remain deliberately absent until later
  approved outcomes.
