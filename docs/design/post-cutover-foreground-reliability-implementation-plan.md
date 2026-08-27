# Post-Cutover Foreground Reliability Implementation Plan

Status: implemented in the repository working tree on 2026-08-26; Implementation Evidence Review is pending. Live activation remains unauthorized.

## Authorization and stopping point

Architecture Review was approved on 2026-08-26. This plan translates ADR-0116 through ADR-0118 into repository work. Approval of this plan authorizes repository-local implementation and isolated tests through the Implementation Evidence Review. It does not authorize:

- migrations against the live Runtime;
- replacement of the installed `dist` program;
- Worker or LaunchAgent restart;
- Hook, Codex configuration, native-memory, or Vault changes;
- activation of the new foreground path;
- commit, push, PR, or release publication.

Implementation stops after producing the evidence and exact Activation Review package described below.

## Constraints carried forward

- One managed continuous MemStore process, one LaunchAgent, one owner-only foreground Unix socket, and one resident E5 model owner.
- One-second client-visible automatic-retrieval deadline and 300-millisecond warm-path p95 target.
- No Luna, Terra, network provider, Memory Candidate, or unvalidated representation in automatic retrieval.
- Existing ranking, Relevance Bands, token budgets, Context Epoch rules, authority, scope, sensitivity, and Project isolation remain unchanged.
- Canonical Memory and the Memory Vault receive no migration.
- Existing valid files under `spool/capture/pending/` remain importable by both the old and new program.
- The previous complete index and Retrieval Snapshot remain usable throughout a failed build.
- TypeScript remains strict; new protocols use discriminated unions and Zod validation without `any` or unchecked broad records.

## Current-to-target map

| Current implementation | Target Module | Main reason |
|---|---|---|
| `src/capture/emergency-spool.ts` is used only after SQLite busy | Capture Inbox | Remove normal Hook dependence on the SQLite writer |
| `src/retrieval/foreground-ipc.ts` starts work without cancellation | Foreground Retrieval Lane | Own admission, deadline, disconnect, and completion semantics |
| `src/retrieval/packs.ts` loads SQLite scope and vectors per request | Retrieval Snapshot-backed pack engine | Keep foreground work in memory and revision-consistent |
| E5 is loaded by `configuredWorkerAdapters` on the main thread | Foreground Runtime worker-thread Adapter | Isolate foreground progress while retaining one model owner |
| `runWorkerOnce` decides directly when to rebuild | Index Build Coordinator | Coalesce catalog changes and enforce one follow-up build |
| `retrieval_receipts.latency_ms` mixes delivered and abandoned work | `foreground_attempts` plus successful Receipts | Separate client-visible outcome from server cleanup |

## Source layout

### New source files

| File | Responsibility |
|---|---|
| `src/capture/inbox.ts` | Deep Capture Inbox Module: prepare, append, inspect, import, capacity, checksum, permissions, and legacy-file compatibility |
| `src/capture/inbox-files.ts` | Private version-one file-envelope codec and importer retained behind the Capture Inbox public Module |
| `src/retrieval/foreground-attempts.ts` | Body-free foreground attempt persistence, bounded overflow aggregation, inspection, and retention |
| `src/retrieval/foreground-lane.ts` | Deep Foreground Retrieval Lane: admission, deadline, cancellation, cooperative execution, outcome, and body-free attempt telemetry |
| `src/retrieval/foreground-runtime.ts` | Main-thread supervisor Adapter for the worker thread; exposes background embedding, Snapshot publication, recent pressure, and close |
| `src/retrieval/foreground-thread.ts` | Production worker-thread entry: loads E5, owns the socket, executes foreground requests, and serves low-priority document-embedding batches |
| `src/retrieval/snapshot.ts` | Builds and validates immutable Snapshot transfer objects from a completed index revision and vector sidecar |
| `src/retrieval/index-coordinator.ts` | Dirty-generation state, quiet/max timers, build lease, failure cooldown, and one follow-up generation |
| `migrations/0050-foreground-attempts.sql` | Body-free foreground outcome and stage timing ledger |
| `migrations/0051-retrieval-catalog-generations.sql` | Catalog generation singleton and `memory_catalog` change triggers |
| `scripts/evidence-foreground-reliability.ts` | Isolated contention, cancellation, scale, compatibility, and performance evidence |

### Existing source files changed

| File | Planned change |
|---|---|
| `src/adapters/codex/hook.ts` | Prepare and append Capture dispositions before optional Project resolution; remove direct normal SQLite Capture writes and legacy busy/lost fallback |
| `src/cli/codex-hook.ts` | Send protocol-v2 deadline, preserve fail-open output, and distinguish completed from busy/deadline/unavailable without user-facing noise |
| `src/cli/command.ts` | Start the Foreground Runtime for continuous `worker run`; keep direct embedding loading for one-shot CLI/MCP paths |
| `src/retrieval/foreground-client.ts` | Add `deadlineAt`, protocol-v2 results, and exact one-second client timing |
| `src/retrieval/foreground-ipc.ts` | Become the thin socket Adapter over Foreground Retrieval Lane; remove direct pack orchestration |
| `src/retrieval/foreground-protocol.ts` | Version 2 request/response schemas with `busy`, `deadline_exceeded`, and `unavailable` outcomes |
| `src/retrieval/packs.ts` | Extract deterministic selection over a fixed Snapshot; use cooperative stage checks and a 50-millisecond final ledger transaction |
| `src/retrieval/index.ts` | Read immutable Canonical revisions, embed missing documents in explicit batches of 16, stage revision-scoped FTS rows, and publish with a short pointer transaction |
| `src/retrieval/shadow-worker.ts` | Submit low-priority observe-only work through the same pack engine and skip when foreground pressure exists |
| `src/runtime/database.ts` | Register migrations 0050 and 0051; no default busy-timeout change for unrelated callers |
| `src/worker/main.ts` | Import a bounded Inbox batch first, use Index Build Coordinator, publish Snapshots, and yield low-priority work to recent foreground pressure |
| `src/operations/status.ts` | Report Capture Inbox, foreground outcomes, cancellation, post-deadline work, thread state, Snapshot identity, and index generations |
| `src/operations/maintenance.ts` | Add doctor checks for Inbox age/capacity, repeated deadlines, post-deadline work, thread availability, and stale catalog generation |
| `src/integration/managed.ts` | No installed Hook or LaunchAgent shape change; include new evidence fields in upgrade/repair previews only if program identity changes |
| `src/configuration/index.ts` | Add optional index quiet-period and maximum-staleness settings with accepted defaults; existing configs load without rewrite |

`src/capture/emergency-spool.ts` is removed. The public behavior lives in `src/capture/inbox.ts`; the checksummed version-one disk codec is isolated in the private `src/capture/inbox-files.ts` helper so legacy compatibility does not enlarge the public Module. Historical files remain compatible through the Capture Inbox implementation, not through the deleted source name.

Implementation also adds `foreground_event_reservations` to migration 0050. Capture Inbox durability means active retrieval can run before the corresponding event reaches `capture_events`; the old Shadow table has a Capture foreign key and therefore cannot reserve that interval safely. The new body-free reservation ledger preserves exactly-once behavior across “foreground first, Inbox import later” without retaining prompt or Memory bodies.

## Runtime schemas

### Migration 0050: foreground attempts

`foreground_attempts` stores no prompt, pack body, Memory body, command, error text, or credential. Planned columns are:

```sql
CREATE TABLE foreground_attempts (
  attempt_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('SessionStart', 'UserPromptSubmit')),
  event_id TEXT,
  project_id TEXT,
  receipt_id TEXT REFERENCES retrieval_receipts(receipt_id) ON DELETE SET NULL,
  index_revision_id TEXT REFERENCES retrieval_index_revisions(index_revision_id),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'completed', 'empty', 'busy', 'deadline_exceeded',
    'cancelled', 'unavailable', 'failed'
  )),
  admission_delay_ms REAL NOT NULL CHECK (admission_delay_ms >= 0),
  compute_ms REAL NOT NULL CHECK (compute_ms >= 0),
  receipt_commit_ms REAL NOT NULL CHECK (receipt_commit_ms >= 0),
  observed_client_elapsed_ms REAL NOT NULL CHECK (observed_client_elapsed_ms >= 0),
  cancellation_observed_ms REAL,
  post_deadline_work_ms REAL NOT NULL DEFAULT 0 CHECK (post_deadline_work_ms >= 0),
  created_at TEXT NOT NULL,
  completed_at TEXT NOT NULL
) STRICT;
```

Indexes cover `(created_at)`, `(outcome, created_at)`, and `(project_id, created_at)`. Retention follows bounded Injection Receipt operational retention and is implemented through the existing maintenance path.

Successful and empty deterministic pack decisions continue to create `retrieval_receipts`. Busy, deadline, cancellation, unavailable, and failed attempts create only body-free `foreground_attempts`. A completed response must reference its successful Receipt. The foreground thread emits one body-free attempt message after the outcome is fixed; the main Worker buffers at most 1,024 messages and persists them outside the foreground critical path. Buffer pressure coalesces body-free counts by outcome and time bucket rather than blocking retrieval. Diagnostic loss during whole-process failure is reported as an observability limitation and cannot be mistaken for Capture loss.

### Migration 0051: retrieval catalog generations

```sql
CREATE TABLE retrieval_catalog_generations (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  dirty_generation INTEGER NOT NULL CHECK (dirty_generation >= 0),
  published_generation INTEGER NOT NULL CHECK (published_generation >= 0),
  building_generation INTEGER,
  dirty_at TEXT,
  force_due_at TEXT,
  last_completed_at TEXT,
  last_failed_at TEXT,
  CHECK (published_generation <= dirty_generation)
) STRICT;
```

SQLite triggers on `memory_catalog` insert, relevant update, and delete advance `dirty_generation`, set `dirty_at`, and preserve the first `force_due_at` in a continuous dirty interval. The migration initializes published and dirty generation to zero when a compatible complete active index exists. Absence or adapter mismatch still requires an immediate build independently of generation.

The Coordinator captures `building_generation` before reading source rows. A successful publication advances `published_generation` only to that generation. If `dirty_generation` is newer, one follow-up remains due.

## Capture Inbox implementation

### File compatibility and dispositions

Normal events keep the current schema-version-one checksummed envelope and `pending/*.json` location. The importer continues to accept files produced by the installed version.

New body-free dispositions use `dispositions/*.json` with:

- schema version and disposition identity;
- event, Agent, Session, Turn, and Project-path identities where available;
- non-reversible sensitivity fingerprint and category;
- `blocked_secret` or `quarantined` state;
- timestamps, retained byte count of zero, and content checksum.

The suspect body is absent. Status and doctor expose only counts, bytes, age, and disposition categories.

### Hook ordering

For every supported Hook:

1. Parse and normalize the bounded event.
2. Run pure size and sensitivity preparation.
3. Attempt the existing short Project resolution. Failure or SQLite busy leaves `projectId` absent but does not block Capture.
4. Atomically append the prepared disposition with the original `cwd` for later resolution.
5. Report Capture success only after the file is durable.
6. Attempt active retrieval only when a Project was resolved and the event is eligible.

This order guarantees durable Capture even when Project Registry or SQLite is busy. The importer resolves an absent Project from the saved path before writing the Durable Outbox.

### Capacity and import

- Capacity admission uses a short owner-only filesystem lock around exact count/byte inspection and atomic rename; it never acquires SQLite.
- Lock acquisition and stale-lock recovery are bounded inside the Hook deadline and covered by parallel-Hook tests.
- Limits are 2,048 files and 512 MiB. Warnings begin at 75 percent and critical state at 90 percent.
- One Worker iteration imports at most 64 dispositions or spends at most 25 milliseconds importing, whichever occurs first.
- If Inbox files remain after the batch, `runWorkerOnce` returns after the import activity so the next one-second iteration continues draining before starting heavy work.
- SQLite busy leaves the exact file pending. Duplicate event identity completes import and removes the file without creating another event.

Legacy `hook-sqlite-busy.ndjson` remains readable as historical telemetry but new normal Hook traffic no longer appends to it.

## Foreground Retrieval Lane implementation

### External protocol

Protocol version 2 adds `deadlineAt` to every request and these wire outcomes:

```ts
type ForegroundWireResponse =
  | CompletedResponse
  | EmptyResponse
  | { state: "busy"; requestId: string }
  | { state: "deadline_exceeded"; requestId: string }
  | { state: "unavailable"; requestId: string; code: string };
```

The client creates `deadlineAt` from its local one-second budget before opening the socket. The server converts wall-clock time to a local monotonic remaining budget at admission. Version mismatch, restart race, malformed data, or missing endpoint remains fail-open.

### Admission and cancellation

- One request may be admitted. There is no waiting queue.
- While occupied, newly parsed requests receive `busy` immediately.
- Each admitted socket owns an `AbortController`.
- Socket `close`, socket `error`, parent shutdown, thread shutdown, or deadline expiry aborts the request.
- Each asynchronous stage and each cooperative computation chunk calls the internal control before starting more work.
- Ranking, lexical scoring, relationship expansion, and pack rendering process bounded chunks and yield with `setImmediate` so the socket can observe disconnects and reject concurrent callers.
- Query embedding is one bounded E5 batch. If cancellation occurs during ONNX execution, that batch may finish; the control then stops before vector scan, ranking, Receipt, or another model call.

No successful Receipt or Context Epoch increment is committed after disconnect or deadline. The final Receipt transaction opens SQLite with `busyTimeoutMilliseconds: 50`; failure returns `unavailable` without context.

### Immutable Retrieval Snapshot

The main thread builds the Snapshot from one completed index revision, `retrieval_documents`, revision-scoped FTS-compatible searchable text, and the verified vector sidecar. The Snapshot transfer object contains validated plain arrays, maps represented as entries, and a transferable `Float32Array` buffer. Zod validates it before and after transfer.

The worker thread holds exactly one active Snapshot. `publishSnapshot` constructs the complete next object on the background thread, posts it to the foreground thread, and swaps only after validation. In-flight requests retain their original object. Snapshot construction therefore cannot block the foreground event loop.

SessionStart precomputes ordered Project/Global bucket rows by tier and category. UserPromptSubmit reads Project plus Global rows from Snapshot maps, performs cooperative lexical and exact-vector scoring, and uses the same deterministic selection functions currently covered by pack tests.

### One E5 owner

The continuous Worker no longer loads E5 in `configuredWorkerAdapters`. `startForegroundRuntime` starts the worker thread, waits for its validated embedding identity, and returns a low-priority `EmbeddingAdapter` to the main thread.

`buildRetrievalIndex` explicitly chunks missing documents into groups of at most 16 and sends one group per thread message. The thread admits foreground query embedding before the next document batch. `WorkerAdapters.embedding` continues to satisfy the existing Interface, so index code and tests do not learn worker-thread message details.

One-shot `worker once`, explicit CLI recall, and MCP keep their current temporary direct-adapter lifecycle. This plan does not expand a foreground reliability repair into an explicit-recall transport change. A temporary explicit process may overlap the managed Worker as it can today, but it does not create a second resident owner, socket, LaunchAgent, or lifecycle. Existing overlap memory use remains visible in the final RSS evidence.

### Thread supervision

- The parent owns startup, readiness, shutdown, and unexpected-exit handling.
- The socket starts only after E5 identity and an initial valid Snapshot are ready. Without an active index it may start in an explicit unavailable state while the first build runs.
- An unexpected thread exit removes or invalidates the socket, records a body-free unavailable attempt, and retries after 1, 5, then 30 seconds, capped at 30 seconds.
- Luna, Capture Inbox import, Candidate work, and governance continue while foreground retrieval is unavailable.
- Parent shutdown waits a bounded interval for the thread, then terminates it without altering Runtime or Vault data.

## Index Build Coordinator implementation

### Due rules

A build is due when any of these holds:

- no complete active index exists;
- adapter identity differs from the active index;
- dirty generation exceeds published generation and the 30-second quiet period elapsed;
- dirty generation exceeds published generation and the two-minute force deadline elapsed;
- the previous build failed and its five-minute cooldown elapsed.

Only one build lease exists. Recent foreground pressure delays a quiet-period build; a force-due build starts but every embedding and publication batch yields between batches.

### Consistent build and publication

- Source rows are captured with the target generation.
- The builder reads the exact immutable Canonical revision recorded by each row through `readCanonicalRevision`, not a later current file.
- Compatible vectors are reused. Missing vectors are embedded in explicit batches of 16.
- Retrieval documents and FTS rows for the new revision are inserted in bounded batches while the old active revision remains selected.
- The final transaction marks the new revision complete and swaps `active_retrieval_index`; it does not delete and rebuild all active FTS rows while holding the pointer transaction.
- Retired FTS and document rows are pruned later in bounded batches through the existing snapshot-pruning path.
- Snapshot publication follows successful index selection. Failure to transfer or validate the new Snapshot leaves the previous Snapshot active and marks the refresh for retry without corrupting the selected index.

## Worker scheduling changes

`runWorkerOnce` keeps one orchestration Interface but changes its order:

1. Import a bounded Capture Inbox batch; return early if Inbox work remains.
2. Recover foreground reservations and inspect pressure.
3. Schedule or advance one index-coordinator step.
4. Prepare and run at most the existing bounded Luna/Candidate work.
5. Run Shadow evaluation only through the shared low-priority pack path and only without foreground pressure.
6. Run quality, duplicate, governance, and reminder work under existing eligibility checks plus foreground pressure yielding.

No new background task begins during active foreground work or within 250 milliseconds of observed pressure, except force-due index work and already-leased model work. Existing Luna calls are not cancelled merely because a foreground request arrived.

## Test-first phases

### Phase 1: Capture Inbox

Write failing tests before changing Hook code:

- Rename `tests/fault/emergency-spool.test.ts` to `tests/fault/capture-inbox.test.ts` and change its test surface to `appendCaptureDisposition`, `inspectCaptureInbox`, and `importCaptureInboxBatch`.
- Hold `BEGIN IMMEDIATE`, run normal `Stop`, `SessionEnd`, `UserPromptSubmit`, and `PostToolUse` Hooks, and assert every result is durable without a SQLite write.
- Run 20 parallel Hooks and assert unique files, exact idempotent import, no overwrite, and completion within host deadlines.
- Prove Secret and quarantine files contain no source body or reversible body hash.
- Prove count, byte, permission, malformed-file quarantine, stale-lock recovery, and legacy version-one import behavior.
- Update `tests/contract/codex-hook.test.ts`, `tests/contract/codex-hook-entrypoint.test.ts`, `tests/fault/hook-worker-contention.test.ts`, status, and doctor tests.

Then implement `src/capture/inbox.ts`, change Hook ordering, and update Worker import priority. Phase completion requires the focused Capture, Hook, status, doctor, and worker-idle suites to pass.

### Phase 2: Snapshot-backed deterministic packs

Write failing tests that build two index revisions and assert:

- one request never mixes revisions;
- a Snapshot swap does not alter an in-flight result;
- current SessionStart and UserPromptSubmit selected identities, order, representation, token count, omissions, and Context Epoch behavior remain unchanged;
- 2,500 Project rows plus current-scale Global rows complete deterministic non-embedding work within the allocated budget;
- cancellation during cooperative ranking stops before Receipt.

Refactor `src/retrieval/packs.ts` behind the Snapshot input and add `src/retrieval/snapshot.ts`. Existing `tests/integration/retrieval/shadow-packs.test.ts` remains the semantic regression suite and is adapted to the new Interface rather than duplicated.

### Phase 3: Foreground Lane and worker thread

Write the production failure as a deterministic red test:

- Hold the first request at a controllable stage for 20 seconds.
- Assert the client fails open by one second.
- Assert later callers receive `busy` promptly instead of waiting.
- Disconnect the first client and assert no successful Receipt, no Context Epoch increase, no later stage, and no post-deadline work beyond the current E5 batch.

Add tests for thread startup, version mismatch, malformed request, crash/restart, shutdown, socket permissions, one E5 owner, and low-priority document embedding. A child-process contention test runs background Worker work while an independent Hook process measures the real socket.

Then add `foreground-lane.ts`, `foreground-runtime.ts`, `foreground-thread.ts`, protocol v2, client v2, and the thin socket Adapter. Update CLI continuous-worker startup last so the old path remains runnable during repository work.

### Phase 4: Index Build Coordinator

Write fake-clock tests for:

- 100 rapid catalog changes producing one initial and at most one follow-up build;
- quiet-period, continuous-change force deadline, foreground-pressure yield, one-build lease, and five-minute failure cooldown;
- catalog change during build publishing a consistent target generation and scheduling one follow-up;
- immutable revision reads;
- short final pointer transaction and old-index availability;
- bounded cleanup of retired FTS and document rows.

Then add migration 0051, `index-coordinator.ts`, explicit document embedding batches, revision-scoped FTS staging, Snapshot publication, and Worker scheduling integration.

### Phase 5: Operations and evidence

Add migration 0050, foreground attempt recording, status and doctor fields, retention, and the evidence script. The script runs only against operating-system temporary Vault and Runtime roots unless an explicit later command supplies a reviewed read-only replay source.

It reports:

- Capture Inbox durability, throughput, oldest age, count, bytes, and loss;
- foreground completed, empty, busy, deadline, cancellation, unavailable, and failed counts;
- p50, p95, p99 client-observed, admission, compute, Receipt, and post-deadline timings;
- index builds per catalog burst, generations, failures, and active Snapshot continuity;
- CPU, peak RSS, thread restart, socket permissions, and model-owner count;
- exact selected Memory identities and representation parity without bodies.

## Test files

Expected new or renamed tests are:

- `tests/fault/capture-inbox.test.ts`
- `tests/fault/foreground-deadline-cancellation.test.ts`
- `tests/fault/foreground-thread-recovery.test.ts`
- `tests/fault/index-coalescing.test.ts`
- `tests/integration/retrieval/foreground-lane.test.ts`
- `tests/integration/retrieval/snapshot-swap.test.ts`
- `tests/e2e/foreground-reliability-loop.test.ts`
- `tests/helpers/foreground-thread-fixture.ts`

Existing affected suites are updated in place:

- `tests/contract/codex-hook.test.ts`
- `tests/contract/codex-hook-entrypoint.test.ts`
- `tests/fault/hook-worker-contention.test.ts`
- `tests/fault/index.test.ts`
- `tests/fault/retrieval-worker.test.ts`
- `tests/fault/worker-idle-lock.test.ts`
- `tests/integration/operations/doctor-retry-worker.test.ts`
- `tests/integration/retrieval/foreground-ipc.test.ts`
- `tests/integration/retrieval/index-build.test.ts`
- `tests/integration/retrieval/shadow-packs.test.ts`
- `tests/integration/retrieval/shadow-worker.test.ts`

Tests assert behavior through Capture Inbox, Foreground Retrieval Lane, and Index Build Coordinator Interfaces. Old tests that reach past those Interfaces are replaced rather than layered on top of the new tests.

## Verification commands

Each phase runs its focused Vitest files first. Final repository evidence requires fresh success from:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm benchmark:active-injection
pnpm exec tsx scripts/evidence-foreground-reliability.ts
git diff --check
```

The installed LaunchAgent currently points directly at this checkout's ignored `dist/` directory. Before Activation Review, build verification therefore uses `tsc -p tsconfig.build.json --outDir <isolated-temp>/dist`; running the ordinary `pnpm build` in this checkout would replace the installed on-disk program and is outside repository-local authorization. The ordinary command returns only after Activation Review authorizes replacement.

The evidence script must reproduce the old abandoned-request pattern before the new Adapter is selected in its isolated fixture, then pass with the new Adapter. A green test that never demonstrates the old failure is insufficient.

## Expected machine effects after later activation

These effects are described for review but remain unauthorized during implementation:

- additive migrations 0050 and 0051 apply to the live Runtime database;
- existing pending emergency-spool files become normal Capture Inbox entries without rewrite;
- the same LaunchAgent restarts once and starts one Node.js worker thread;
- E5 moves from the main event loop to that thread; no second E5 pipeline remains loaded;
- the existing Unix socket path is recreated with mode `0600`;
- Hook JSON, Codex config, native-memory flags, Vault files, Project Registry, Skills, MCP configuration, and notification permissions do not change;
- active Codex Sessions do not need individual restart and fail open during the brief Worker restart.

## Activation package to produce, not execute

Implementation Evidence Review must include:

1. exact commit, source diff, migration hashes, and built-program hash;
2. full test and isolated evidence results;
3. current live doctor/status, queue, index, Hook, Cutover, CPU, RSS, and foreground baseline;
4. migration preview against a copy made with the SQLite backup interface;
5. backup path and SHA-256 for the currently installed built program;
6. exact Worker restart and post-restart probe commands;
7. exact restore-previous-build and Worker restart rollback commands;
8. proof that normal pending Inbox files remain old-version compatible;
9. a 24-hour observation report template with natural and isolated opportunities separated.

No command in that package is executed until Activation Review approval.

## Rollback behavior

The later activation rollback restores the previous built program and restarts the same LaunchAgent. It does not revert additive migrations, delete Capture Inbox files, change native-memory flags, or modify the Vault.

- Normal pending Inbox files remain readable by the previous version-one importer.
- Body-free disposition files remain owner-only and pending; the old program ignores them without deleting them.
- New Runtime tables remain unused but valid.
- The previous complete index remains selected if activation failed before a new publication.
- A new index published by the new build remains schema-compatible; the old program may continue serving it when its adapter identity matches.
- Canonical Memory written during observation is preserved.

Immediate rollback is recommended for wrong-Project or Secret injection, Capture disposition loss, Hook host-timeout breach, repeated thread crash, Receipt/Context Epoch inconsistency, active-index corruption, or inability to restore the socket after one controlled Worker restart.

## Risks and containment

| Risk | Containment and evidence |
|---|---|
| Worker-thread message or startup complexity | One supervisor Interface, discriminated protocols, fixture Adapter, crash/restart tests |
| E5 background batches still delay a foreground query | Explicit batch-16 messages, foreground priority between batches, post-deadline timing evidence |
| Snapshot memory duplicates index data | Transfer vector buffer ownership, retain one active Snapshot, measure peak RSS at current scale |
| Capture Inbox file churn | Worker-first batch import, bounded capacity, APFS-compatible atomic files, throughput evidence |
| Filesystem capacity lock becomes a new Hook bottleneck | Very short file-only critical section, parallel-Hook timing and stale-lock tests |
| Project resolution still sees SQLite busy | Capture remains durable with path-only disposition; injection skips safely until Project resolves |
| New FTS staging retains old rows too long | Revision-bound queries and bounded retired-snapshot pruning |
| Shadow duplicates active retrieval | Existing event reservation plus low-priority shared pack path; exact-once tests |
| Additive migration blocks rollback | Old program ignores new tables; migration rehearsal uses a backup copy |

## Implementation Evidence Review acceptance

Repository implementation is ready for review only when all of these are true:

- every planned migration, source file, test, and status field is present or an explicit reviewed plan amendment explains its absence;
- the old 19.7-second abandoned-request pattern is red under the old Adapter and green under the new one;
- client-visible hard deadline violations are zero in isolated contention tests;
- post-deadline work beyond one bounded E5 batch is zero;
- Capture disposition loss is zero under held SQLite locks, parallel Hooks, crash, restart, and capacity tests;
- deterministic selected identities, representations, budgets, scope, and safety match the accepted behavior;
- one hundred rapid catalog changes cause no more than two builds;
- previous index and Snapshot remain available through build, thread, and publication failure;
- full repository verification is green;
- no live Runtime, Vault, Hook, Codex configuration, LaunchAgent, or installed program changed.

Approval at that Review authorizes preparation and execution of the separately reviewed Activation package only. It does not authorize commit, push, PR, or release publication unless those actions are explicitly requested.
