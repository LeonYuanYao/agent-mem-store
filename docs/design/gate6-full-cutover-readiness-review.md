# Gate 6 Full Cutover Readiness Review

Status: approved and activated; post-Cutover machine verification passed.

Prepared at: 2026-08-25. The live Codex configuration and Hook files were not
changed while preparing this package.

## Execution record

The Human approved Gate 6 on 2026-08-25. Program commit
`cutover-baseline-2026-08-25` was pushed to `origin/main`, the
Worker restarted onto that build, and `doctor --deep` passed before activation.
The approved digest remained unchanged, so the single Cutover activated at
`2026-08-25T22:08:54.636Z`.

- Live Codex config SHA-256:
  `096473bff61bc8cfa0aca7b26fd71eaec3e93e28425068e39ba414dd08ef7ea6`
  (unchanged).
- Live Codex Hooks SHA-256:
  `23a8abe472250693017c2863c685db85b9299b16b819cc532ebae38dc7611afa`.
- Rollback manifest:
  `<runtime-root>/cutover/<cutover-id>/manifest.json`.
- A live new-Session probe returned a 1,192-token SessionStart pack in 219.7
  milliseconds. Its relevant UserPromptSubmit probe returned a 155-token pack
  in 186.7 milliseconds. Both Capture evaluations and Receipts completed.
- A resumed historical Session probe returned a non-empty 1,181-token
  SessionStart pack in 295.5 milliseconds.
- Explicit current-Project recall returned the requested Memory first with both
  lexical and semantic evidence. An isolated missing-socket probe returned the
  accepted empty fail-open result without blocking the Session.
- Final `doctor --deep` remained healthy, the emergency spool remained empty,
  the Worker remained running, and the foreground socket remained owner-only.

Codex subsequently wrote the five active Hook trust hashes into its host-owned
`hooks.state`; this existing Session also received MemStore context. Host trust
is therefore confirmed rather than pending.

### Post-Cutover timeout and rollback adjustment

Production receipts later showed one useful UserPromptSubmit pack completing in
807.7 milliseconds. The Human approved a one-second foreground wait, with a
two-second Codex command-Hook timeout so the client can still serialize or fail
open after retrieval. Codex also rewrote the five expected `hooks.state` trust
hashes after activation; rollback now preserves only those host-owned hash values while
restoring the reviewed Memory flags and Hook document, and still rejects every
other configuration change.

## Recommendation

MemStore is ready for a reviewed Full Cutover if the Human accepts one explicit
performance tradeoff: the current-scale active path stayed below the former
500-millisecond deadline in the reviewed benchmark, but UserPromptSubmit did not meet the aspirational
300-millisecond p95 target. The proposed Cutover therefore includes immediate
production verification and an identity-checked rollback path.

The package initially exposed a real blocker. At 3,741 indexed documents,
SessionStart kept searching after its 1,200-token pack was already too full for
the smallest valid item. It timed out without returning the otherwise complete
pack. The fix stops only when no valid item can mathematically fit; it does not
drop an item that could have been packed. A regression test now protects that
boundary.

## Shadow coverage and knowledge quality

| Evidence | Observed result | Interpretation |
| --- | ---: | --- |
| Consecutive Shadow duration | 8 calendar days | The required seven-day window is complete and Gate 6 eligible. |
| Captured Events during the window | 16,560 | Includes long sessions and tool-heavy work. |
| Retrieval Receipts during the window | 1,007 | Covers SessionStart, UserPromptSubmit, and explicit retrieval activity. |
| Completed Shadow evaluations | 781 | The remaining difference is ordinary captured work that did not require an automatic retrieval evaluation. |
| Confirmed irrelevant observations | 3 | All three Bad Cases and their Class B repairs are resolved. |
| Canonical Memory growth | 3,428 | Current catalog validation covers 4,064 entries; 3,741 active documents are indexed. |
| Explicit retrieval Receipts, lifetime | 212 | Explicit deep reads are exercised independently of automatic injection. |

Three Source-first Verification runs were Human-confirmed. The first two sampled
24 source-derived units: 10 contained eligible durable knowledge, of which 7
were represented and 3 were missed; the other 14 were correct omissions. The
third run rechecked all three misses after repair and matched all three. This is
positive evidence that the known misses were repaired, but the sample remains
too small to claim statistical completeness.

The current admission evidence also shows that the early filter is doing real
work: recent Luna decisions include 496 `no_memory`, 189 `session_only`, 44
`uncertain`, and 196 `source_echo` dispositions. Fifteen Project-phase
Candidates were held before canonical promotion. This evidence does not prove
that every promoted Memory is valuable; the Source-first runs remain the
quality evidence for recall coverage.

Fresh repository verification passes: TypeScript typecheck, ESLint, production
build, and 314 tests across 84 files are green.

## Active injection latency

The historical Shadow aggregates do not meet the current latency targets:

| Path | Samples | p50 | p95 | p99 | Over 500 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| SessionStart Shadow history | 224 | 454.5 ms | 663.8 ms | 879.1 ms | 59 |
| UserPromptSubmit Shadow history | 570 | 439.4 ms | 1,427.9 ms | 3,832.3 ms | 246 |

Those aggregates include the superseded asynchronous path and pre-optimization
history. They are retained here so the Readiness Review does not present only
the favorable measurements.

The final isolated current-scale benchmark used a SQLite online snapshot of the
live Runtime, the copied active E5 index, 3,741 indexed documents, the real Hook
process, Project resolution, durable Capture into the isolated database, the
Unix socket, resident E5 query embedding, deterministic ranking, Receipt
persistence, and official Hook JSON serialization. It ran 30 SessionStart and
30 UserPromptSubmit requests; all 60 returned non-empty context.

| Active path at 3,741 documents | p50 | p95 | p99 | Maximum | Non-empty packs |
| --- | ---: | ---: | ---: | ---: | ---: |
| SessionStart | 201.1 ms | 302.5 ms | 315.5 ms | 315.5 ms | 30/30 |
| UserPromptSubmit | 358.7 ms | 411.9 ms | 459.0 ms | 459.0 ms | 30/30 |

The hard 500-millisecond boundary passes. SessionStart is within measurement
noise of the 300-millisecond p95 target; UserPromptSubmit misses that soft SLO.
This is an observed residual risk, not a hidden pass. Explicit MCP and Skill
retrieval remain outside the automatic deadline.

## Current operating health and recovery evidence

- `doctor --deep` reports `healthy`: SQLite integrity is `ok`, the Vault catalog
  validates 4,064 entries, the emergency spool is empty, and Luna has no active
  or blocked operation.
- All 11,643 recorded Luna operations are completed. All three governance runs
  and all three governance obligations are completed or satisfied. The latest
  weekly run covers through 2026-08-24 and has no error category.
- All 3 recorded Bad Cases are resolved, with 3 resolved Class B repair cases.
- The active Worker is running, its last exit code is zero, and the foreground
  Unix socket is owner-only (`0600`).
- Sensitivity handling retains no quarantined body: 43 blocked-secret findings
  and 1,068 quarantined finding aggregates have `body_retained = 0`.
- The isolated purge evidence passes ordinary purge, restore and pin protection,
  content-identity recheck, idempotence, bounded execution, crash recovery,
  catch-up, body-free tombstones, and index/catalog agreement. The real Vault
  was not purged for evidence generation.
- The live emergency-spool history contains 184 lost SQLite-busy captures:
  182 predate outcome-aware spool reporting and 2 occurred after the spool was
  introduced. The last loss was at 2026-08-25T08:54:56Z. Eight later busy events
  through 2026-08-25T19:40:00Z were durably spooled, and the spool is currently
  empty. Full Cutover does not make Capture loss impossible when both SQLite and
  the emergency spool fail; it preserves fail-open Agent behavior and surfaces
  the incident.

## Exact proposed machine change

The reviewed dry-run has approval digest
`9cff24d592d10e31729e556e6734444c71429cb30d1a1a7603f54b69adfeaf75`.
It is valid only while both source hashes still match:

| File | Before SHA-256 | Target SHA-256 |
| --- | --- | --- |
| `~/.codex/config.toml` | `096473bff61bc8cfa0aca7b26fd71eaec3e93e28425068e39ba414dd08ef7ea6` | unchanged |
| `~/.codex/hooks.json` | `6b3caff8c309a20538d87e65b0244d62c6aed45de9ed538bdd835142709da15e` | `23a8abe472250693017c2863c685db85b9299b16b819cc532ebae38dc7611afa` |

The Codex native-memory settings are already
`generate_memories = false` and `use_memories = false`, so the Cutover performs
no TOML edit. It changes only the five owned MemStore Hook commands from
`MEMSTORE_INJECTION_MODE=shadow` to `active`, changes their owned marker suffix
from `:shadow` to `:active`, and adds the accepted host output limits:

- SessionStart: `additionalContextLimit = 1200`;
- UserPromptSubmit: `additionalContextLimit = 1024`;
- PostToolUse, Stop, and SessionEnd: no context output limit because they do not
  inject context.

The preview parser requires exactly one owned Shadow route for each event and
leaves every unrelated route unchanged. Any file drift aborts before mutation.
The activation command also refuses to run without the reviewed approval digest.

Codex treats a changed Hook definition as new trusted configuration. The Human
must review and trust the new definition when Codex prompts; this trust step is
not automated. See the official [Codex Hooks reference](https://learn.chatgpt.com/docs/hooks).

## Native-memory preservation

Cutover performs no import, move, delete, or body read. The body-free inventory
recorded four existing locations:

| Location | State | Count / size at preview |
| --- | --- | ---: |
| `~/.codex/memories_1.sqlite` | file | 2,375,680 bytes |
| `~/.codex/memories_1.sqlite-wal` | file | 70,072 bytes |
| `~/.codex/memories_1.sqlite-shm` | file | 32,768 bytes |
| `~/.codex/memories` | directory | 366 files, 154 directories, 4,057,790 bytes |

These values are inventory evidence, not a promise that WAL or SHM sizes remain
constant. Rollback depends on restoring the native-memory configuration and the
owned Hook file, not on importing native bodies into MemStore.

## Activation, verification, and rollback

Before activation, commit the reviewed source, run the full verification suite,
build `dist`, restart the Worker onto that build, confirm `doctor --deep` and the
owner-only foreground socket remain healthy, and regenerate the preview.
If the source hashes or approval digest change, the new package requires Human
review rather than reusing this approval.

The approval digest binds the two machine configuration files and their exact
targets. The committed program revision is a separate Gate 6 verification item;
it must be recorded and checked immediately before activation.

After explicit Gate 6 approval, the approved executor:

1. rechecks both source hashes and the approval digest;
2. creates an owner-only backup directory under Runtime Data containing the
   exact pre-Cutover config, Hook file, and a body-free Cutover manifest;
3. applies the native-memory flags first if needed, then atomically activates
   the owned Hook file;
4. returns the exact manifest path used by `integration rollback-cutover`.

The post-Cutover check must cover a new Codex Session and one resumed supported
Session. It verifies trusted Hooks, SessionStart context, a relevant
UserPromptSubmit context, a persisted Receipt, duplicate suppression, MCP
recall, `doctor --deep`, Worker/socket health, and the fail-open result when the
foreground endpoint is unavailable.

Rollback is immediate for any secret body injection, cross-Project scope leak,
malformed Hook output that disrupts a Session, or repeated Capture/Receipt
failure after one Worker restart. A single irrelevant Memory is recorded as a
Bad Case rather than forcing rollback; repeated confirmed noise is reviewed
against the active repair policy. Performance exceeding one second or
returning deadline failures in production triggers rollback review. The
rollback command refuses to overwrite files that diverged after Cutover,
restores Hooks before native-memory configuration, verifies both backup hashes,
and never deletes MemStore or native-memory data.

Approval of this document authorizes exactly one Full Cutover using the reviewed
source and target identities. It does not authorize native-memory deletion,
import, release publication, or unrelated Codex configuration changes.
