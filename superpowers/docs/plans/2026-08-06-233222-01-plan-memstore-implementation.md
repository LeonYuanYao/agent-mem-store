# MemStore v1 Implementation Plan

**Goal:** Deliver a low-maintenance, program/data-separated MemStore v1 that can capture Codex session evidence without blocking turns, distill it through Luna, keep Obsidian-readable Canonical Memory, retrieve precise Project and Global knowledge, govern it over time, and prove a reversible direct cutover from Codex native memory.

**Why planning is required:** The system crosses Agent lifecycle Hooks, a background model, durable queues, manually editable Markdown, retrieval indexes, scheduled governance, macOS integration, and a destructive archive lifecycle. A staged plan is required to preserve authority and security invariants, keep machine effects reviewable, and prevent implementation work from silently becoming installation or cutover.

**Acceptance:** Each outcome below passes its named verification and evidence checks; Gate 3, Gate 4, Gate 5, and Gate 6 each stop for explicit human Review; no global installation, real-Vault write, official Shadow start, or Full Cutover occurs before its authorized Gate.

Status: Gate 2 approved. Outcomes 1-5 are implemented as a repository-local
Gate 3 candidate on 2026-08-07. This status does not authorize installation or
Outcome 6 work.

## 1. Authorization and stop rules

- Gate 2 approval authorizes repository-local Core Foundation implementation only, through Outcome 5.
- Outcome 5 stops at Gate 3. The remaining Engineering MVP cannot begin until the user explicitly approves that Review.
- Outcome 11 stops at Gate 4. Repository-local purge, repair, and managed-integration prerequisite work cannot begin until the user explicitly approves that Review.
- Development Shadow installation is not implied by Gate 4 approval; it requires an explicit approval that names the installation.
- Outcome 13 stops at Gate 5. Only Gate 5 approval starts the official seven-consecutive-day Shadow window.
- Outcome 14 stops at Gate 6. Full Cutover requires one explicit approval after the complete Readiness Report.
- Repository implementation never implies commit, push, PR, release, publication, dependency installation outside this repository, or a change to Codex, Obsidian, LaunchAgents, global Skills, or MCP configuration.
- Every destructive-path test uses an isolated test Vault with short test-only retention. It must never target `<vault-root>`.
- Any conflict during Git synchronization stops in the conflict state under the repository Git-safety policy. This plan does not authorize synchronization.

## 2. Proposed architecture

The implementation is one TypeScript package with several process entrypoints, plus one small Swift notification helper. It is not a distributed system and does not introduce a web server, ORM, vector database, or Agent framework.

```text
Codex lifecycle event
        |
        v
Codex Hook adapter -- sanitize/bound --> Capture module --> SQLite Durable Outbox
                                                        |
                                                        v
                                               Distillation Worker
                                               /       |        \
                                              v        v         v
                                          Luna     Promotion   Governance
                                              \        |         /
                                               v       v        v
                                            Canonical Memory Vault
                                                     |
                                  +------------------+------------------+
                                  v                  v                  v
                              exact/FTS5       embedding index     Review Inbox
                                  \                  /
                                   v                v
                              Recall module / Shadow Pack builder
                                   |          |           |
                                  CLI        MCP      Codex injection adapter
```

The architecture uses deep modules: callers invoke a small behavioral interface while transaction ordering, validation, retries, identities, and failure semantics remain inside the module. CLI, MCP, Skills, and Codex Hooks are adapters over the same interfaces, not separate implementations.

### 2.1 Deep modules and seams

| Module | External interface | Behavior kept inside |
| --- | --- | --- |
| Configuration | load, validate, preview change, activate | dual-file ownership, unknown-field preservation, cross-field checks, last-known-good recovery, atomic replacement |
| Project Resolution | resolve, inspect, preview/apply explicit project action | marker precedence, Git normalization, submodule inheritance, Registry updates, collision handling |
| Capture | accept normalized event, inspect capture health | Secret detection, bounded segmentation, deduplication, atomic Outbox commit, fail-open result |
| Memory Lifecycle | assert, enqueue extraction, inspect/resolve operation | authority, scope, evidence, Candidate state machine, conflict, quarantine, promotion, revision creation |
| Canonical Vault | read/reconcile/write revision, rebuild catalog | namespaced frontmatter, human-edit detection, immutable history, atomic compare-and-swap, tombstones |
| Recall | search, show, provenance, related, build pack, report irrelevant | eligibility, hybrid ranking, token rendering, cursors, receipts, epoch accounting, Bad Case aggregation |
| Governance | evaluate obligations, run due work, review action | catch-up/coalescing, checkpoints, Luna work, authorized lifecycle changes, review aggregation |
| Operations | status, doctor, retry, portability, managed-integration preview/apply | ownership checks, diagnostics, safe retries, handoff preconditions, revision-CAS installation |

Only true variability gets a port and adapters:

- `LunaPort`: a production Codex CLI adapter and a deterministic recording adapter for tests.
- `EmbeddingPort`: the selected local Transformers.js adapter and a deterministic fixture adapter for tests and benchmarks.
- `NotifierPort`: the Swift/macOS adapter and a recording adapter for tests.
- Clock and process execution are internal seams used by tests; they do not expand the public module interfaces.
- SQLite and the local filesystem use temporary real instances in tests instead of public repository or filesystem ports.
- Codex is the only host adapter in v1. The normalized lifecycle envelope is an internal contract, not a speculative multi-host framework.

### 2.2 Process entrypoints

- `memstore`: the user-facing CLI.
- `memstore hook codex <event>`: a short-lived, fail-open capture or Shadow-pack adapter. It never invokes Luna.
- `memstore worker run|once`: owns retries, distillation, indexing, reconciliation, governance, and notification dispatch.
- `memstore mcp serve`: a stdio MCP server exposing the five accepted tools through the Recall module.
- `memstore-notifier`: a signed local macOS helper for body-free Notification Center delivery and action callbacks.

SQLite WAL permits short Hook writes while the Worker is active. Hooks use a bounded busy timeout and return control within the host deadline. The Worker obtains narrow leases per logical job; it does not hold a global lock while invoking Luna or computing embeddings.

## 3. Repository layout

The expected source layout is:

```text
MemStore/
  package.json
  pnpm-lock.yaml
  tsconfig.json
  tsconfig.build.json
  vitest.config.ts
  eslint.config.js
  .node-version
  src/
    contracts/              # IDs, envelopes, discriminated states, errors
    configuration/          # policy/config schemas and atomic activation
    projects/               # resolver and explicit project operations
    capture/                # normalized events, sanitizer, Outbox
    memories/               # Candidate, promotion, conflicts, revisions
    vault/                  # Canonical Markdown and reconciliation
    retrieval/              # exact/FTS/semantic search, packs, receipts
    governance/             # ledger, scheduler, weekly/monthly work
    review/                 # Review Inbox, Verification Requests, Bad Cases
    operations/             # status, doctor, retry, portability, install plans
    adapters/
      codex/                # lifecycle and Luna Codex CLI adapters
      embeddings/           # local Transformers.js adapter
      macos/                # notifier process adapter
    cli/                    # argument parsing and response rendering only
    mcp/                    # stdio transport and tool registration only
    worker/                 # job dispatch and process lifecycle only
  schemas/
    json/                   # stable CLI/MCP/Luna/event output schemas
    config/                 # documented policy and machine-config schemas
  migrations/               # ordered forward-only SQLite migrations
  prompts/                  # versioned Luna task prompts
  templates/                # policy, config, Canonical note, Review Inbox
  native/memstore-notifier/ # Swift Package and tests
  skills/
    memstore-remember/
    memstore-recall/
    memstore-repair/        # implemented only in the Gate 5 prerequisite phase
  tests/
    unit/
    contract/
    integration/
    fault/
    e2e/
    fixtures/
    benchmarks/
  docs/design/              # executable-contract documentation and evidence format
  superpowers/docs/plans/   # reviewed implementation plans
```

Files generated during tests use an operating-system temporary directory. Durable test fixtures live under `tests/fixtures`; no test writes to the real Vault or runtime root.

## 4. Canonical Memory schema

### 4.1 Vault layout

The v1 Canonical layout is stable by identity rather than display name:

```text
<Vault>/
  Memories/
    Global/<memory-id>.md
    Projects/<project-id>/<memory-id>.md
  _MemStore/
    policy.toml
    Projects/<project-id>.md
    Revisions/<memory-id>/<revision-id>.md
    Review Inbox.md
```

- A current Memory stays at one identity-stable path across active, archived, and tombstone states. Archive does not move it, so Obsidian links remain stable.
- `_MemStore/Revisions` contains immutable prior Canonical revisions. These are historical authority, not a second current copy.
- Purge removes every retained body-bearing revision covered by the purge and replaces the current note with a body-free tombstone at the same identity path.
- `_MemStore/Projects` stores portable Project identity, display name, aliases that contain no local paths, and merge/migration compatibility metadata.
- `Review Inbox.md` is generated and rebuildable; it contains links, issue categories, bounded evidence labels, and actions, never copied Memory bodies.
- MemStore does not write `.obsidian/`.

### 4.2 Markdown document contract

Each Canonical note is UTF-8 Markdown with YAML frontmatter. MemStore owns only the nested `memstore` object and preserves unrelated top-level properties. Unknown supported-version fields inside `memstore` are preserved on rewrite.

Required current-note fields are:

- `schema_version`, `memory_id`, `revision_id`, `created_at`, `revised_at`.
- `scope.kind` (`project` or `global`) and `scope.project_id` when Project-scoped.
- `authority` (`human_authored` or `agent_derived`) and `origin_kind`.
- `sensitivity` (`normal` or `private`); Secret is not representable in Canonical Memory.
- `lifecycle` (`active`, `archived`, or `tombstone`) with lifecycle timestamps and reason.
- `category`, controlled `importance_tags`, `startup`, applicability, and validity metadata.
- `semantic_contract` with schema version, claims, conditions, exclusions, and preserved negations.
- validated `representations.compact` and `representations.standard`, each with generator identity, source revision, validation result, and rendered-token count.
- portable provenance identities, Injection Receipt references where applicable, outgoing typed relationships, predecessor/successor identities, content identity, and policy version.

The Markdown body is the readable Canonical statement plus applicability, evidence summary, and optional human notes. Agent-derived metadata must not overwrite human-authored wording. A direct Obsidian body edit creates a new Human-authored revision after reconciliation; a metadata-only edit changes only fields the user actually changed.

Immutable revision notes contain the same namespaced schema, revision identity, predecessor identity, and exact historical body. A tombstone retains no Memory body, compact text, standard text, source excerpt, or reversible fingerprint.

### 4.3 Atomicity and manual edits

- Read computes a canonical content identity over owned metadata and body.
- Write requires both the identity observed by the caller and the Runtime catalog
  identity to match the current file before any Agent revision is written. A
  changed or unreconciled file aborts and schedules Human reconciliation.
- Writes use a same-directory temporary file, file synchronization, atomic rename, and parent-directory synchronization where supported.
- A successful write is followed by read-back schema and identity verification before SQLite advances its catalog revision.
- Reconciliation scans changed identities, creates immutable revision history, invalidates derived representations and indexes, reruns local Secret detection, and never silently rewrites a suspected Human-authored Secret.
- v1 deliberately uses a final content recheck rather than a native macOS
  compare-and-swap helper. The remaining check-to-rename race is accepted as a
  low-probability bounded risk; observed Bad Cases, rather than speculation,
  decide whether native machinery is later justified.
- Catalog rebuild recovers an interrupted file/catalog update and recreates a
  missing immutable current revision from the Canonical current note.

## 5. Configuration schemas

Both documents use `schema_version = 1`, reject overlapping keys, preserve unknown fields on compatible rewrites, and enter bounded read-only mode on a higher unsupported schema.

Portable `<Vault>/_MemStore/policy.toml` owns:

- lifecycle and Candidate retention, archive retention, purge protection, and Human-authority defaults;
- Project/Global promotion and corroboration rules;
- automatic injection budgets, ranking thresholds, category rotation, and approved token encoding;
- weekly/monthly governance cadence, stable IANA timezone, startup catch-up delay, and review cadence;
- high-value anomaly thresholds and Luna health/retry policy.

Machine-local `<Runtime>/config.toml` owns:

- Vault and Runtime paths;
- local Project roots, Git evidence cache policy, and adapter installation state;
- selected embedding adapter, immutable model artifact path, checksum, and resource limits;
- Luna provider `codex_cli`, executable path, model `gpt-5.6-luna`, CODEX_HOME/auth reference, sandbox, timeout, and concurrency;
- notifier helper, Notification Center permission state, and LaunchAgent state.

No configuration stores credentials. `codex_cli` uses the named CODEX_HOME authentication state without copying it. A future endpoint adapter may use only an environment or Keychain reference.

## 6. SQLite and index schemas

### 6.1 Runtime database

`<Runtime>/state/memstore.sqlite` is the only primary runtime database. Migrations are forward-only, numbered, transactional, and recorded with source checksum, applied time, and binary version. Before a nontrivial migration, the Worker quiesces writers and uses the SQLite backup mechanism. Migration failure leaves the prior database recoverable and forces read-only doctor/status behavior.

Table families and their invariants are:

- Schema and ownership: `schema_migrations`, `runtime_identity`, `active_configurations`.
- Project Registry: `projects`, `project_roots`, `project_git_evidence`, `project_collisions`, `project_notices`.
- Operations: `operations`, `operation_transitions`, `work_leases`, `retry_schedule`, `dead_letters`.
- Durable Outbox: `capture_events`, `capture_segments`, `capture_attempts`, `capture_health_incidents`.
- Candidate lifecycle: `candidates`, `candidate_evidence`, `semantic_assessments`, `verification_requests`, `human_conflicts`, `secret_fingerprints`, `secret_overrides`, `candidate_tombstones`.
- Canonical catalog: `memory_catalog`, `memory_revisions`, `memory_relationships`, `vault_change_cursor`, `vault_conflicts`.
- Retrieval: `fts_memories` (FTS5), `index_revisions`, `context_epochs`, `retrieval_receipts`, `retrieval_receipt_items`, `explicit_retrieval_chains`.
- Governance: `governance_obligations`, `governance_runs`, `governance_checkpoints`, `review_items`, `notification_attempts`, `model_health_incidents`.
- Quality and repair: `irrelevant_observations`, `bad_cases`, `repair_bundles`, `repair_resolutions`.

Every acknowledged write has an opaque identity, idempotency key, RFC 3339 UTC timestamps, and a state transition guarded by the prior state. Foreign keys are enabled. Lifecycle deletion uses explicit application operations rather than broad cascade deletion of evidence.

Outbox event payloads are versioned JSON after local sanitization. A segment is at most 64 KiB by default; retained sanitized text is at most 1 MiB per Turn. Rows include whole-content and per-segment SHA-256 identities. Incomplete or truncated groups cannot use lightweight promotion.

Secret deduplication uses a machine-local keyed, non-reversible fingerprint. The fingerprint key is obtained from Keychain or generated into a mode-`0600` runtime file; it never enters the Vault, logs, prompts, or exported policy.

### 6.2 Rebuildable retrieval indexes

- Exact metadata and FTS5 live in SQLite and are rebuilt from Canonical Markdown.
- Semantic index revisions live under `<Runtime>/indexes/<index-revision>/` as a manifest plus a contiguous flat vector file ordered by Memory/revision identity.
- The manifest records schema, embedding adapter, model artifact identity and checksum, dimensions, normalization, source Canonical revision set, and per-row content identity.
- Exact vector scan reads the immutable flat file; no ANN library or vector daemon is added.
- A new complete revision is written to a staging directory, verified, atomically renamed, and then selected in one SQLite transaction. Failed builds never replace the last complete index.
- Existing Memory remains available through exact metadata and FTS5 while embeddings rebuild.

## 7. Interface contracts

### 7.1 Hook contract

Codex adapters accept only the verified events `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, and `SessionEnd`. There is no `PreToolUse` Hook.

- A versioned normalized envelope records Agent, event kind, event identity, Project resolution, Session/Turn identity where present, timestamp, bounded structured signals, and the latest Injection Receipt reference.
- `PostToolUse` keeps common metadata and bounded sanitized excerpts under a generic envelope. Unknown tool kinds remain capturable without code changes; optional adapters may improve structure without changing the core event schema.
- `Stop` is the primary per-turn completion signal. `SessionEnd` is advisory and may close or enqueue incomplete-session reconciliation.
- The Hook performs local parsing, Project resolution, Secret/sensitivity screening, segmentation, and one atomic Outbox transaction only.
- Capture failure returns a bounded body-free diagnostic, records a health signal when possible, and fails open for the Codex Turn.
- SessionStart and UserPromptSubmit Shadow pack work has a 500 ms hard fail-open deadline and 300 ms p95 target. Luna is never called in this path.

### 7.2 Worker and Luna contract

- The Worker assembles time- and Turn-bounded batches, preserves Batch identities, and forms later Session-level consolidation work from prior structured results rather than resending every raw event.
- Long Sessions checkpoint multiple batches; a final or delayed consolidation job can unify them through Candidate/evidence identities.
- The production Luna adapter invokes local `codex exec` with `--model gpt-5.6-luna`, `--ephemeral`, read-only sandbox, an isolated working directory, and `--output-schema`.
- Luna receives only sanitized bounded evidence and versioned prompts. It gets no Vault-wide access, credentials, Secret bodies, or authority to execute verification commands.
- Structured outputs cite supplied evidence identities and are validated locally. Invalid output retries under model-health policy and cannot update lifecycle state.
- No fallback model is used. Authentication, invalid-model, and invalid-config failures become immediately visible model-health incidents under ADR-0082.
- Promotion remains a deterministic state transition after Luna advice; confidence text never bypasses evidence, scope, sensitivity, conflict, or authority rules.

### 7.3 CLI, MCP, and Skill contracts

The CLI implements the exact accepted `remember`, `recall`, `project`, initialization, doctor, worker, governance, review, integration, and portability families from the Spec. It uses Node's built-in argument parsing; no CLI framework is added unless executable contract tests prove it inadequate.

- Every meaningful mutation supports strict `--preview` and stable versioned `--json` output.
- Preview runs no Luna call and creates no durable state, audit, backup, marker, or notification.
- CLI response renderers receive typed core results; they do not infer operation completion from prose.
- The MCP stdio server uses the production-recommended v1.x TypeScript SDK line for this milestone and exposes only `memstore_search`, `memstore_get`, `memstore_provenance`, `memstore_related`, and `memstore_report_irrelevant`.
- MCP and CLI normalize into the same Recall requests, cursors, eligibility, pagination, and versioned envelopes.
- `$memstore-remember` and `$memstore-recall` are thin Skill instructions over the canonical CLI/MCP surfaces. `$memstore-repair` is added only in Outcome 12 and remains user-started foreground work.

### 7.4 Token accounting

- Rendered text is counted by a local tiktoken-compatible tokenizer using a reviewed encoding, initially benchmarked with `o200k_base`.
- Every pack and receipt records tokenizer package, encoding, version, rendered text identity, and exact count.
- A conservative safety reserve covers host framing that MemStore cannot see. The reserve is policy-versioned and reviewed during Shadow rather than silently adjusted.
- SessionStart defaults, Relevant Pack limits, Context Epoch 8,192-token soft target and 12,288-token hard cap, and explicit-retrieval warnings follow the accepted Spec.

## 8. Dependency plan

Production dependencies remain intentionally small:

- Node.js `22.17.x` initially, pinned in `.node-version`; ESM TypeScript compiled to JavaScript.
- Built-in `node:sqlite` with SQLite WAL and FTS5. The local runtime has SQLite 3.50.0 and FTS5, but Node 22 marks this interface experimental; Outcome 1 must freeze the supported Node patch range and pass compatibility tests before schema implementation. If it fails, replace this implementation once with `better-sqlite3`; do not maintain dual database adapters.
- `zod` v4 for runtime schemas and discriminated result envelopes.
- `smol-toml` for TOML parsing/serialization and `yaml` for namespaced Obsidian frontmatter, both wrapped by the Configuration or Vault module rather than exposed to callers.
- `@modelcontextprotocol/sdk` stable v1.x plus its required Zod peer for the stdio MCP adapter. The in-development v2 package line is not adopted in v1.
- Stable `@huggingface/transformers` for local ONNX embeddings. The model artifact is not downloaded or activated until the embedding benchmark outcome is approved.
- `js-tiktoken` for local rendered-token accounting without a native build dependency.
- `@js-temporal/polyfill` for IANA-timezone governance obligations and DST-safe first-Monday calculations.

Development dependencies are TypeScript, Vitest, ESLint with TypeScript support, `tsx`, and `fast-check` for resolver, state-machine, cursor, segmentation, and scheduling properties. Swift Package Manager uses no third-party notification package.

No dependency receives unrestricted network or filesystem access merely because it is installed. Lockfile review, license inventory, audit output, and transitive-dependency count are part of Outcome 1 evidence.

## 9. Test and evidence strategy

Tests verify observable module interfaces rather than private helpers.

- Unit/property: IDs, state transitions, policy precedence, token rendering, scheduler math, query binding, Secret patterns and benign negatives.
- Contract: JSON schemas, CLI/MCP parity, Hook envelopes, Luna output validation, Markdown/frontmatter round trips, unknown-field preservation.
- Integration: real temporary SQLite with WAL/FTS5, real temporary filesystem and Vault, real Git repositories/worktrees/submodules, compiled CLI, stdio MCP.
- Fault: duplicate delivery, partial segments, process crash at each checkpoint, SQLite busy/full/corrupt simulation, Vault CAS conflict, invalid config, sleep/catch-up, network/model failures, malformed Luna output.
- End-to-end: synthetic Codex events through Outbox, Worker, Candidate promotion, Canonical write, indexes, Recall, Shadow Packs, governance, Inbox, and recording notifier.
- Benchmark: Hook latency p50/p95/p99, pack deadline, exact vector scan at projected corpus sizes, embedding throughput/resource use, tokenizer cost, and model retrieval quality.
- Native: Swift notifier unit tests and one manual Notification Center action proof before any real installation.

Each Gate receives a generated evidence manifest containing Git worktree state, environment versions, exact commands, exit codes, test artifact identities, unresolved failures, machine-effect inventory, and a claim-to-evidence table. Historical success is never reused as fresh Gate evidence.

## 10. Machine effects and rollback

### Before Gate 4 installation approval

- Allowed effects after Gate 2 approval: repository files, repository `node_modules`, compiled output, package caches, and operating-system temporary test directories.
- Forbidden: real Vault writes, `~/Library/Application Support/MemStore`, `~/.codex`, `~/.agents/skills`, Codex MCP/Hooks, LaunchAgents, Notification Center registration, or model artifact download outside a test-local cache.

### Development Shadow installation, only if explicitly approved at Gate 4

Potential effects are created only after an exact preview:

- `<Vault>/_MemStore/policy.toml`, Canonical directories, and generated Review Inbox;
- `~/Library/Application Support/MemStore` with restrictive permissions, config, SQLite, indexes, logs, manifests, and model artifact;
- managed Codex Hook and MCP entries, global Skill symlinks under `~/.agents/skills`, a LaunchAgent, and the notifier helper;
- no automatic injection and no Codex native-memory change.

Rollback uses ownership manifests, revision compare-and-swap, timestamped backups, and exact-target checks. It removes or restores only MemStore-owned integration entries and symlinks whose targets still match. It never deletes the Vault, Runtime Data, unrelated configuration, or native-memory data.

### Full Cutover

The Gate 6 preview names the exact Codex native-memory settings to disable and the MemStore injection settings to enable. Rollback restores the verified prior native configuration while preserving both memory stores. A critical post-cutover verification failure triggers that prevalidated rollback path, not improvised repair.

## 11. Implementation outcomes

### Outcome 1: Establish the executable repository foundation

- Work: Create the package/toolchain files; enforce strict TypeScript, ESM, supported Node/pnpm versions, test/lint/typecheck/build scripts, stable IDs/errors/result envelopes, and architecture-dependency checks. Add `docs/design/contracts.md` and schema locations. Pin stable MCP v1.x and dependency versions in `pnpm-lock.yaml`; record licenses and audits. Prove `node:sqlite`, WAL, foreign keys, backup, and FTS5 on the pinned Node range before accepting it.
- Risks/open questions: `node:sqlite` remains active-development in Node 22. If compatibility or backup behavior is inadequate, stop before Outcome 2 and propose the one-time `better-sqlite3` replacement for Review. Do not build a dual adapter.
- Verify: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build`

### Outcome 2: Implement initialization, dual configuration, and Project Resolution

- Work: Add a repository-local `memstore init` flow that can target only explicit isolated paths, plus policy/config schemas, atomic activation and last-known-good recovery, higher-version read-only behavior, and portable/machine key separation. Implement marker, Git, submodule, non-Git Registry, collision, preview, and explicit Project operations against temporary repositories. Initialization supports strict preview and idempotent rerun; no ordinary resolution creates `.memstore-project`.
- Risks/open questions: Git provider case rules and unusual submodule layouts can over-merge projects. Default to the conservative collision state and add fixtures before adding provider-specific normalization.
- Verify: `pnpm test -- tests/contract/config tests/integration/projects tests/fault/config`

### Outcome 3: Implement SQLite runtime, Durable Outbox, and Secret containment

- Work: Add initial migrations and runtime ownership; implement bounded versioned events, 64 KiB segments, 1 MiB Turn cap, atomic acknowledgment, idempotent replay, leases/retries/dead letters, capture-health incidents, local Secret detection, benign-negative corpus, keyed fingerprints, and body-free Quarantine. Implement normalized generic PostToolUse capture and Codex Hook fixture adapters without installing Hooks.
- Risks/open questions: catastrophic local SQLite commit failure is fail-open and may lose a capture; report it truthfully and do not add a speculative file spool. New tool formats may reduce extraction detail but must remain safely capturable through the generic envelope.
- Verify: `pnpm test -- tests/integration/outbox tests/contract/hooks tests/fault/outbox tests/unit/secrets`

### Outcome 4: Implement Canonical Vault read/write and reconciliation

- Work: Add namespaced Markdown templates and schemas, atomic CAS writes, immutable revision history, Project catalog, human-edit detection, unknown-field preservation, manual-authority revision behavior, Secret exclusion, tombstone parsing, and catalog rebuild against isolated temporary Vaults. FTS/embedding work is not included yet.
- Risks/open questions: YAML reserialization can disturb user formatting. Golden round-trip fixtures must prove preservation outside the owned `memstore` namespace; if not, replace whole-document serialization with a narrower frontmatter patcher before Gate 3.
- Verify: `pnpm test -- tests/contract/canonical-markdown tests/integration/vault tests/fault/vault`

### Outcome 5: Produce the Gate 3 Core Foundation Review

- Work: Run fresh initialization, configuration, Project, SQLite, Outbox, replay, Secret/Quarantine, Vault, program/data-separation, crash, corruption, and CAS-conflict evidence entirely in isolated test locations. Generate a machine-effect diff proving no real Vault or global Agent configuration was touched. Record unresolved risks and exact repository diff.
- Risks/open questions: Any Secret body retention, acknowledged-event loss, replay duplication, wrong Project resolution, real-Vault write, or non-fail-open Hook result is a Gate blocker, not a waived defect.
- Verify: `pnpm evidence:gate3`

**Mandatory stop:** Present Gate 3 evidence and wait for explicit user approval.

### Outcome 6: Implement Luna batching and the Memory lifecycle

- Work: Implement the Codex CLI Luna adapter, versioned prompts/output schemas, health incidents, backoff, long-Session multi-Batch consolidation, deterministic evidence checks, semantic assessment, Promotion Gate, Direct Human Assertion, extraction, conflicts, Verification Requests, high-value tagging/anomalies, Candidate retention, provenance, revisions, and Memory Echo exclusion.
- Risks/open questions: `gpt-5.6-luna` availability through the authenticated Codex CLI is a hard operational dependency. Invalid model/auth/config produces visible unavailable status; no fallback model or silent direct-Codex substitution is allowed.
- Verify: `pnpm test -- tests/contract/luna tests/integration/lifecycle tests/fault/luna tests/e2e/distillation`

### Outcome 7: Implement indexes, Recall, and Shadow Pack preparation

- Work: Add exact metadata, FTS5, atomic flat-vector index revisions, hybrid ranking, relevance bands, compact validation and fallbacks, one-hop relationships, query-bound cursors, progressive reads, Injection Receipts, Bad Case aggregation, Context Epoch accounting, and non-injected SessionStart/UserPromptSubmit packs. Benchmark at least one lightweight and one quality-oriented local embedding model on representative Chinese, English, code, path, and error cases; freeze artifact checksum only after Review evidence.
- Risks/open questions: Local model download, first-load time, memory use, and corpus scan time may exceed the 500 ms path. Preload the selected adapter in the Worker and publish precomputed indexes; Hook work remains local and bounded. If no candidate passes, retain exact/FTS explicit recall and stop before claiming automatic semantic readiness.
- Verify: `pnpm test -- tests/integration/retrieval tests/contract/recall tests/fault/index && pnpm benchmark:retrieval`

### Outcome 8: Implement CLI, MCP, and capture/recall Skills

- Work: Implement exact accepted Remember, Recall, Project, operation, and read-only status contracts; stable JSON envelopes; strict preview; wait semantics; stdio MCP tools; `$memstore-remember`; and `$memstore-recall`. Exercise CLI/MCP parity through the same module interfaces. Keep Skills repository-local and uninstalled.
- Risks/open questions: stdout logging can corrupt stdio MCP. Protocol output is stdout-only and diagnostics go to stderr. Unsupported Codex selection identities fail explicitly.
- Verify: `pnpm test -- tests/contract/cli tests/contract/mcp tests/e2e/explicit-memory`

### Outcome 9: Implement complete weekly/monthly governance

- Work: Add stable-IANA-timezone obligations, Monday 19:00 weekly and first-Monday 19:00 monthly scheduling, startup delay, missed-run coalescing, fixed coverage bounds, paginated checkpoints, weekly consolidation/relationships/staleness, monthly full metadata/graph audit, Human-authority Review Suggestions, bounded summaries, and model-health-aware retry.
- Risks/open questions: Catch-up must not starve foreground capture or double-apply changes. Coverage cursor advances only after the complete logical run succeeds; one deep run executes at a time and yields to capture/index backlog.
- Verify: `pnpm test -- tests/unit/scheduling tests/integration/governance tests/fault/governance`

### Outcome 10: Implement Review Inbox, macOS notifier, doctor, recovery, and portability

- Work: Generate rebuildable body-free Review Inbox views and type-checked actions; implement the Swift notifier and recording adapter; aggregate/snooze/acknowledge reminder obligations; add status/doctor/retry/worker commands, runtime backup, drain/pause, Vault validation, destination rebuild, and retrieval verification. Do not implement Runtime database merge or export/import.
- Risks/open questions: macOS notification actions and permission denial need one real manual proof before installation approval. If native action callbacks are unreliable, notification delivery may degrade to body-free open-Inbox behavior, but obligations remain visible in doctor and Inbox.
- Verify: `pnpm test -- tests/integration/review tests/e2e/portability tests/fault/recovery && swift test --package-path native/memstore-notifier`

### Outcome 11: Produce the Gate 4 Engineering MVP Review and integration preview

- Work: Run the complete uninstalled Shadow data loop and synthetic Secret, duplicate, crash, sleep, network, Luna, Vault, index, governance, notification, and portability exercises. Produce embedding benchmark evidence, latency percentiles, quality samples, a global machine-effect preview, managed-install ownership design, and unresolved limitations. Confirm automatic injection and native-memory changes remain disabled.
- Risks/open questions: Engineering MVP can record purge obligations but cannot execute purge, and can record Bad Cases but cannot claim the repair loop complete. Those are explicit Gate 5 prerequisites.
- Verify: `pnpm evidence:gate4`

**Mandatory stop:** Present Gate 4 evidence and exact machine-effect preview. Wait for explicit approval before any Gate 5 repository work or any development Shadow installation.

### Outcome 12: Implement the archive purge prerequisite

- Work: Implement previewable, checkpointed, yielding purge batches; recheck authority, pin, retain-forever, retention, content identity, successor, restoration, and index state immediately before mutation; remove every covered body/revision and retain permanent body-free tombstones. Prove ordinary purge, idempotence, restore protection, crash recovery, catch-up, and Vault/SQLite/index agreement using only a short-retention isolated test Vault.
- Risks/open questions: This is destructive. Any target ambiguity, real-Vault path, missing backup evidence, stale content identity, or inability to prove tombstone agreement aborts without deletion.
- Verify: `pnpm test -- tests/destructive/purge && pnpm evidence:purge`

### Outcome 13: Implement the reviewed Bad Case repair and managed-integration prerequisites

- Work: Add `$memstore-repair` with stored Bad Case/receipt/sample/version context, Codex + GPT-5.6 foreground guidance, reviewed proposal/application/replay flow, Class A/B self-test and Class C observation rules. Implement preview/repair/uninstall ownership for Codex Hooks, MCP, Skill symlinks, LaunchAgent, notifier, and cutover/rollback configuration. Run a synthetic irrelevant case end to end and rehearse native-memory cutover/rollback without deleting or importing native data. Freeze one candidate configuration.
- Risks/open questions: Repair is never a background model action. Managed integration must abort on concurrent or user-modified state and preserve unrelated Hooks, MCP, plugins, order, fields, and files.
- Verify: `pnpm test -- tests/e2e/repair tests/integration/managed-install tests/fault/managed-install && pnpm evidence:gate5`

**Mandatory stop:** Present Gate 5 evidence. Wait for explicit approval before installing the frozen official configuration or starting the seven-day Shadow window.

### Outcome 14: Run official Shadow, Gate 6 Review, and one approved cutover

- Work: After Gate 5 approval, install the frozen Shadow configuration, run seven consecutive natural days, execute required recovery exercises, collect adaptive quality evidence and all fixed zero-tolerance results, and produce the Readiness Report with exact cutover/rollback diff. After separate Gate 6 approval, perform one cutover and verify new Sessions, supported existing Sessions, Hooks, MCP, automatic injection, fail-open behavior, and rollback readiness.
- Risks/open questions: Sparse data is reported honestly and may lead to an extension; it is not filled with synthetic production claims. Any fixed safety failure, acknowledged loss, duplicate Canonical effect, wrong-scope injection, Hook blocking, unproven purge/repair, or critical post-cutover failure blocks or rolls back cutover.
- Verify: `memstore readiness report --window official --json` followed, only after approval, by the reviewed cutover command and `memstore doctor --deep --json`.

**Mandatory stop:** Gate 6 approval is required before the cutover command. A critical post-cutover check follows the rehearsed rollback path while preserving both stores.

## 12. Gate 2 Review decisions requested

Approval of this plan confirms the following implementation choices for Core Foundation:

- one strict TypeScript/Node package plus one later Swift notifier helper;
- deep capability modules and shared CLI/MCP/Hook adapters;
- identity-stable Canonical notes with hidden immutable revisions in the Vault;
- one SQLite runtime database, built-in `node:sqlite` subject to the Outcome 1 compatibility stop, FTS5 in SQLite, and flat semantic index files outside it;
- Codex CLI as the sole Luna production adapter with no fallback model;
- stable MCP v1.x for v1, local Transformers.js embeddings selected by benchmark, and local versioned token accounting;
- the exact phase boundaries, machine-effect restrictions, stop conditions, evidence commands, and rollback rules above.

Approval does not authorize any implementation beyond Outcome 5, any commit/push, or any global/machine integration.

## 13. External dependency references checked for this plan

- Node.js 22 documents `node:sqlite` as active development even though it no longer needs the experimental flag: <https://nodejs.org/docs/latest-v22.x/api/sqlite.html>.
- The official MCP TypeScript SDK currently recommends v1.x for production while v2 is still in development: <https://github.com/modelcontextprotocol/typescript-sdk> and <https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/README.md>.
- Stable Transformers.js installs as `@huggingface/transformers`: <https://huggingface.co/docs/transformers.js/installation>.
- OpenAI's tokenizer defines `o200k_base`; the JavaScript package choice remains locally benchmarked and version-recorded: <https://github.com/openai/tiktoken>.
