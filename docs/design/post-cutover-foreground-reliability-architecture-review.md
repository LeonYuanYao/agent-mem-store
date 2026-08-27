# Post-Cutover Foreground Reliability Architecture Review

Status: approved on 2026-08-26. Approval authorizes the Implementation Plan only.

## Approved decision

The approved post-Cutover architecture is recorded in ADR-0116 through ADR-0118 and the matching SPEC changes. Approval authorizes an Implementation Plan only. It does not authorize repository implementation, a Worker restart, installed-program replacement, Hook change, Runtime migration against the live database, or activation.

The review fixes five values for the first implementation:

| Decision | Proposed value |
|---|---:|
| Foreground requests executing at once | 1 |
| Ordinary foreground waiting queue | 0 |
| Foreground Receipt SQLite busy wait | 50 ms maximum |
| Index build quiet period / maximum staleness | 30 seconds / 2 minutes |
| Capture Inbox capacity | 2,048 files or 512 MiB |

## Why this change is necessary

Post-Cutover checks reproduced three related failures against the live Runtime without reading or printing Memory bodies:

- Three requests for the same `acme-workspace` Project all failed open at approximately 1,002–1,007 milliseconds. A control request for the 12-Memory MemStore Project also timed out, ruling out Project size as the sole cause.
- The server continued work after those clients disconnected. The first abandoned request completed after 19.7 seconds; two later requests needed only 670 and 782 milliseconds of computation but had already timed out while waiting behind it. Earlier Receipts recorded 30–60-second server work.
- SQLite busy diagnostics continued to accumulate. The emergency spool reached 14 pending files and cumulative `lost` dispositions increased from 191 to 205 before the system later caught up.

The system eventually returned to `healthy`, drained the spool, published a complete index, and served a 56.3-millisecond probe. That recovery proves that existing data and fallback paths work; it does not remove the load-dependent failure. The active implementation starts `prepareResponse` without a server-owned deadline or disconnect cancellation, runs foreground work on the same event loop as Worker orchestration, writes Capture directly to SQLite first, and rebuilds indexes for small successive catalog changes.

No evidence showed SQLite corruption, wrong-Project injection, Secret body retention, Vault inconsistency, blocked Luna work, or a need to change E5 weights, ranking thresholds, token budgets, or Canonical Memory.

## Target module shape

### Foreground Retrieval Lane

The external seam remains the owner-only Unix socket. The Module exposes one behavior:

```ts
type ForegroundResult =
  | { state: "completed"; receiptId: string; text: string; renderedTokenCount: number }
  | { state: "empty"; reason: string }
  | { state: "busy" }
  | { state: "deadline_exceeded" }
  | { state: "unavailable"; code: string };

retrieve(request: ForegroundRequest): Promise<ForegroundResult>;
```

The Interface includes these invariants:

- `deadlineAt` is supplied by the client and converted to a local monotonic remaining budget when admitted.
- At most one request executes. There is no ordinary waiting queue.
- A socket close or expired deadline cancels the request before another stage starts.
- A successful result uses one immutable Retrieval Snapshot and commits its Receipt and Context Epoch update before response.
- A busy Receipt transaction waits at most 50 milliseconds. Failure returns no context and does not consume epoch tokens.
- E5 may finish only the current non-interruptible batch after cancellation. Ranking, relationships, packing, and Receipt work cannot continue afterward.

The production Adapter is one Node.js worker thread inside the existing process. Tests use an in-process Adapter with a controllable clock, cancellable stage barriers, a temporary Runtime, and a deterministic embedding fake. The worker thread is an internal seam; Hook and Worker callers do not learn its lifecycle or message protocol.

### Retrieval Snapshot

The Snapshot is immutable and bound to:

- active index revision and adapter identity;
- active configuration version;
- Memory and representation content identities;
- eligible Project and Global rows;
- lexical state and exact vectors;
- validated compact, identity, and standard representations;
- relationship adjacency used by one-hop expansion.

Publication creates the complete next Snapshot before an atomic pointer swap. An in-flight request keeps its original Snapshot. A failed or incomplete refresh leaves the previous Snapshot serving.

### Capture Inbox

Hooks no longer need the main SQLite writer lock. The Capture Inbox Module exposes one behavior:

```ts
type CaptureDisposition =
  | { state: "event"; event: BoundedCaptureEvent }
  | { state: "blocked_secret"; finding: BodyFreeFinding }
  | { state: "quarantined"; finding: BodyFreeFinding };

append(disposition: CaptureDisposition): Promise<{ state: "durable"; identity: string }>;
```

The Module validates the schema, content identity, sensitivity disposition, byte and file limits, permissions, and atomic exclusive write. The Hook reports success only after `durable`. The Worker imports the oldest file first, rechecks identity, commits idempotently to the existing SQLite ledger, and then removes the file.

Normal events retain the current version-one emergency-spool envelope so the previous installed Worker can import them after rollback. New body-free Secret and quarantine dispositions live in a separate subdirectory. An older Worker may leave those files untouched during rollback, but cannot expose or delete their bodies because none are present.

### Index Build Coordinator

The Coordinator owns a monotonic dirty catalog generation, the quiet-period timer, the maximum-staleness timer, the one-build lease, and one follow-up generation. Callers only mark the catalog dirty; they do not decide whether to build.

One build snapshots one generation and may publish it even when a newer generation arrives. Compatible vectors are reused, E5 remains batch-16, and each low-priority batch yields to foreground pressure. A failure leaves the current Snapshot and index active, records the failure, and observes the existing five-minute retry cooldown.

## Scheduling and SQLite behavior

Worker priority is fixed as follows:

1. Import Capture Inbox dispositions.
2. Allow foreground Receipt commits.
3. Recover expired foreground reservations and abandoned work.
4. Commit bounded Candidate and index publication state.
5. Run Luna distillation and semantic assessment.
6. Run low-priority index embedding.
7. Run compact-quality, duplicate, weekly, and monthly maintenance.

Background computation stays outside SQLite transactions. Write transactions use bounded batches and yield before starting another batch when the Foreground Retrieval Lane is occupied or observed pressure during the previous 250 milliseconds. This priority does not cancel a correctly leased Luna call; it prevents new local work from monopolizing the Runtime writer or E5 executor.

## Runtime data and migration

The target adds no Canonical Memory fields and performs no Vault migration.

Expected additive Runtime changes are:

- a `foreground_attempts` body-free table for admitted, busy, cancelled, deadline, unavailable, and completed outcomes;
- a singleton index dirty-generation record with dirty, building, and published generations and timestamps;
- bounded Capture Inbox disposition files under the existing Runtime spool root;
- a rebuildable in-memory Retrieval Snapshot owned by the foreground thread.

`retrieval_receipts` remains the record of completed pack decisions. `foreground_attempts` records client-visible latency, admission delay, computation, Receipt commit, cancellation observation, and post-deadline work separately. A computation that finishes after its client failed open cannot masquerade as delivered injection latency.

Migrations are additive. The previous program ignores the new tables. Existing Capture Event, Candidate, Memory, index, Project, governance, and cutover identities remain unchanged.

## Implementation order and evidence

Implementation must be test-first at the external seams.

1. **Deadline and cancellation tests**
   - A disconnected client cannot create a successful Receipt or increase Context Epoch tokens.
   - A blocked request causes later callers to receive `busy` within the deadline; no caller waits behind it.
   - Deadline expiry leaves no queued work and at most one bounded E5 batch finishing.

2. **Capture Inbox tests**
   - A held SQLite writer lock cannot prevent a normal, Secret, or quarantine disposition from becoming durable.
   - Crash and restart import files idempotently without duplicate Capture Events or knowledge.
   - Capacity, checksum failure, permissions, and old-version normal-event compatibility are proven in temporary Runtime roots.

3. **Snapshot and build-coalescing tests**
   - One request cannot mix Snapshot revisions.
   - One hundred rapid catalog changes produce no more than the initial and one follow-up build.
   - An index failure keeps the previous complete Snapshot serving.

4. **Real-scale replay**
   - Replay body-protected query identities and synthetic representative prompts against at least 2,500 Project Memories and the current catalog scale.
   - Verify exact selected identities and representations against the accepted deterministic pack implementation.
   - Measure p50, p95, p99, busy, deadline, cancellation, CPU, and peak RSS without printing Memory bodies.

Repository evidence must pass the full test suite, typecheck, lint, build, isolated fault tests, and a deterministic contention test that previously reproduced the 19.7-second abandoned request.

## Activation and rollback

Implementation completion does not activate this design. Activation requires a separate Review containing:

- the exact commit and built-program identity;
- the additive migration preview;
- a backup of the currently installed built program;
- the Worker restart command and expected socket downtime;
- a rollback command that restores the previous build and restarts the same LaunchAgent;
- pre- and post-restart doctor, Hook, socket, index, Inbox, and direct-retrieval probes.

Hook definitions, native-memory flags, Project Registry, Memory Vault, and the socket path do not change. Current Codex Sessions spawn the installed Hook command for each event, so they do not require manual restart. During the short Worker restart, automatic injection fails open and Capture continues through the Inbox.

Rollback preserves all Canonical Memory and Runtime work. Normal pending Inbox files remain readable by the previous importer. New body-free disposition files remain owner-only and pending until the new build is reactivated or an explicit compatible importer handles them. Additive SQLite tables remain harmless and are not dropped.

Immediate rollback triggers are wrong-Project or Secret injection, a Hook exceeding its host timeout, Capture disposition loss, repeated foreground-thread crash, Receipt or Context Epoch inconsistency, or corruption of the active index. A p95 miss alone opens a performance review when every request still fails open correctly; it does not discard knowledge or automatically restore Codex native memory.

## Post-activation observation

The first 24 hours report all available natural opportunities rather than claiming statistical confidence from a fixed quota. Isolated probes supplement sparse traffic but are reported separately. Activation is considered stable only when:

- client-visible hard deadline violations are zero;
- post-deadline work beyond one bounded E5 batch is zero;
- Capture disposition loss is zero;
- the Capture Inbox drains after foreground activity and its oldest item stays below two minutes under normal operation;
- foreground p95 is at or below 300 milliseconds, or any miss has a named, bounded cause and no self-amplifying queue;
- index bursts coalesce as designed and the last complete Snapshot always remains usable;
- Luna, Candidate, Vault, governance, scope, sensitivity, and retrieval-quality checks remain healthy.

The existing Shadow window may continue collecting observations, but it cannot duplicate active foreground execution for the same event. No additional Luna or Terra call is introduced by this architecture.

## Explicitly unchanged

- E5-base q8 weights, adapter identity, batch-16 vector semantics, and semantic thresholds.
- Ranking, Relevance Bands, startup policy, relationship eligibility, and representation rules.
- Automatic token budgets and explicit recall behavior.
- Memory authority, lifecycle, sensitivity, Project identity, and Vault formats.
- One managed LaunchAgent, one MemStore process, and one owner-only local socket.
- Codex native-memory cutover state and preserved rollback data.
