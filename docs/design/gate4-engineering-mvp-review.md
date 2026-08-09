# Gate 4 Engineering MVP Review

Status: review candidate; mandatory human stop. Repository-local and
uninstalled.

## Review scope

Gate 4 reviews the complete uninstalled Engineering MVP. It does not authorize
a development Shadow installation. The authoritative generated manifest is
`artifacts/evidence/gate4.json`; it records the source identities, exact
commands and exit codes, quality evidence, machine topology before and after,
and the integration preview. The artifact is intentionally ignored by Git
because it contains machine-local paths and execution evidence.

The end-to-end synthetic exercise uses only operating-system temporary
directories. It runs Codex-shaped capture through the durable Outbox, a fake
Luna boundary, Candidate promotion, Canonical Markdown, retrieval indexing,
non-injected SessionStart and UserPrompt packs, Monday governance, Review Inbox,
and a recording notifier. Human-authored Memory remains authoritative when
Agent-derived knowledge conflicts.

## Evidence map

| Claim | Principal evidence |
| --- | --- |
| Complete uninstalled Shadow loop | `tests/e2e/gate4-shadow-loop.test.ts` |
| Secret containment, duplicate replay, and crash recovery | Capture, Outbox replay, and recovery fault suites listed in the manifest |
| Network, unavailable Luna, malformed Luna, and retry behavior | Luna health and Worker fault suites |
| Vault compare-and-swap, index failure, governance checkpoint, and catch-up | Vault, index, and governance fault suites |
| Explicit Recall and CLI/MCP parity | Retrieval, CLI, MCP contract, and explicit-memory suites |
| Body-free Review Inbox and durable notification obligations | Review, reminder delivery, and native Swift contract suites |
| Complete knowledge portability without Runtime import | Vault handoff and Runtime backup suites |
| No automatic injection or native-memory replacement | Shadow-pack contracts plus external topology snapshots |

The evidence command also performs a frozen dependency install, lint,
type-check, full tests, production build, Swift tests, production dependency
audit, and production license inventory.

## Latency and embedding boundary

The benchmark records p50, p95, and p99 for Hook capture, SessionStart pack
preparation, and UserPrompt pack preparation over synthetic local data. The
external automatic-path target remains below 500 milliseconds. UserPrompt
semantic work now has a 300-millisecond internal cutoff, candidate paging stops
at 450 milliseconds, and the remaining time is reserved for deterministic
ranking, packing, Receipt persistence, and serialization. A slow or unavailable
embedding adapter degrades to lexical retrieval.

The embedding benchmark executes the frozen E5-base q8 Shadow candidate from an
operating-system temporary cache. It records artifact identity, load and query
latency, memory use, and retrieval quality over the accepted small bilingual
synthetic corpus. This proves executable compatibility, not production quality;
official quality decisions still require the seven-day Shadow labels.

## Exact installation preview

No preview item has been applied. A separately authorized development Shadow
installation would create only these owned surfaces:

- Vault policy plus `Memories/Global` and `Memories/Projects` directories;
- mode-0700 Runtime Data, model, and notifier under
  `~/Library/Application Support/MemStore`;
- one managed MemStore entry in each of Codex `SessionStart`,
  `UserPromptSubmit`, `PostToolUse`, `Stop`, and `SessionEnd`, preserving all
  existing entries and adding no `PreToolUse` entry;
- one `mcp_servers.memstore` entry while preserving existing MCP servers and
  every native-memory setting;
- global symlinks for `memstore-remember` and `memstore-recall`;
- one MemStore-owned Worker LaunchAgent.

The preview explicitly excludes `.obsidian`, Claude settings, unrelated Codex
Hooks/MCP/Skills, automatic Memory injection, and Codex native-memory changes.
The generated manifest contains each resolved absolute target and operation.

## Ownership and rollback design

A future managed installer must validate and preview the complete diff before
mutation, compare the current revision, create a timestamped recoverable
backup, replace atomically, and read back both syntax and ownership. Its
ownership manifest records preexisting and expected post-install identities.
Rollback may touch only manifest-owned entries whose current identity still
matches. Concurrent or user-authored divergence aborts rollback; Vault data,
Runtime Data, unrelated integrations, and native-memory data are never deleted.

## Known limitations

- Archive purge obligations are recorded but executable purge is Outcome 12.
- Bad Cases are stored and reported, but the user-started GPT-5.6 repair Skill
  and managed integration are Outcome 13.
- Native notification contracts are automated; Notification Center permission,
  live delivery, click callback, and Obsidian opening still require a separately
  authorized manual proof before installation.
- Embedding quality evidence is synthetic and cannot replace official Shadow
  evidence.
- The pinned Node 22 runtime still labels `node:sqlite` experimental, although
  the compatibility, WAL, FTS5, backup, and fault suites pass.

## Approval boundary

Approving Gate 4 authorizes only repository-local Outcome 12 and Outcome 13
prerequisite implementation. It does not install Hooks, MCP, Skills, a Worker,
model, notifier, or LaunchAgent; write the real Vault; deliver a real
notification; invoke real Luna; start the official seven-day Shadow window; or
replace Codex native memory. Any development Shadow installation requires a
separate explicit authorization naming that installation.
