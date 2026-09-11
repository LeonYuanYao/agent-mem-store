# Source map

Read this map to choose a module, then read that module's README before editing it. Paths below describe the current implementation, not an exhaustive API reference.

## Main processing paths

```text
Codex hooks -> capture inbox -> worker distillation -> admission -> candidates
                                                              -> canonical Vault
Canonical Vault -> quality / embeddings / index publication -> retrieval -> hooks or MCP
Canonical Vault -> governance / retention -> guarded lifecycle changes
Canonical Vault -> capacity -> recall working-set membership
```

The CLI and MCP delegate to application operations. SQLite stores durable work and derived indexes; Markdown in the Vault is canonical knowledge. Background extraction, automatic prompt injection and explicit recall have different latency and authorization requirements.

## Module guides

| Module | Responsibility |
| --- | --- |
| [admission](admission/README.md) | Classifies model output before Candidate creation; records why statements were admitted, rejected or isolated. |
| [candidates](candidates/README.md) | Owns candidate identities, evidence-based evaluation, Human assertions, conflicts, expiration and high-value anomaly handling. |
| [capture](capture/README.md) | Accepts host events and makes them recoverable for background processing without running knowledge extraction in a hook. |
| [configuration](configuration/README.md) | Loads portable Vault policy and machine-bound runtime configuration, validates compatibility and controls injection/display settings. |
| [contracts](contracts/README.md) | Provides result envelopes, atomic file writes, runtime capability checks and local sensitivity classification. |
| [projects](projects/README.md) | Resolves directories into memory scopes, handles explicit project markers and tracks session-specific project routes. |
| [health](health/README.md) | Computes retrieval/index health from observed failures, recovery evidence and publication state. |
| [sensitivity](sensitivity/README.md) | Summarizes captured sensitivity findings and removes expired diagnostic metadata under policy. |
| [runtime](runtime/README.md) | Opens the SQLite runtime database, applies migrations when requested, and configures access for readers and writers. |
| [lifecycle](lifecycle/README.md) | Centralizes calendar-month archive retention and purge deadline calculation. |
| [mcp](mcp/README.md) | Exposes supported recall and memory lifecycle operations through the Model Context Protocol. |
| [purge](purge/README.md) | Executes due archive-body cleanup and explicit single-memory purge with safety rechecks and recoverable backup state. |
| [cli](cli/README.md) | Parses user commands, resolves configuration and dispatches operations; provides separate lightweight Codex hook startup. |
| [operations](operations/README.md) | Provides user-facing use cases shared by command and tool surfaces: setup, recall, remembering, lifecycle changes, diagnostics and migration. |
| [capacity](capacity/README.md) | Tracks per-space pressure and selects a bounded recall working set; coordinates capacity obligations separately from ordinary governance coverage. |
| [quality](quality/README.md) | Maintains compact representations and discovers/reviews duplicate or subsumption relationships. |
| [integration](integration/README.md) | Plans and applies installation of hooks, MCP configuration, worker launch settings and supporting assets. |
| [luna](luna/README.md) | Defines structured model requests/responses and invokes the configured Codex subprocess for extraction, consolidation and governance. |
| [review](review/README.md) | Builds the Obsidian review surface, applies explicit review actions and delivers bounded reminders. |
| [repair](repair/README.md) | Tracks user-initiated irrelevant-retrieval repair proposals, approvals, application evidence and verification. |
| [memories](memories/README.md) | Defines shared category vocabulary, compact checks and portable numeric reference resolution. |
| [vault](vault/README.md) | Owns canonical Memory files, portable project metadata, revision identity, manual-edit reconciliation and catalog synchronization. |
| [worker](worker/README.md) | Drives capture import, distillation, candidate processing, quality, governance, retention, indexing and reminders. |
| [governance](governance/README.md) | Runs restartable scans that propose and apply evidence-supported changes to durable knowledge. |
| [retrieval](retrieval/README.md) | Builds derived search snapshots, selects relevant memories and serves both explicit recall and automatic hook injection. |
| [adapters](adapters/README.md) | Contains host-specific translations at the edge of MemStore; domain rules remain in shared modules. |
| [adapters/codex](adapters/codex/README.md) | Maps supported Codex events into project-scoped, durable capture and bounded session evidence. |
| [adapters/macos](adapters/macos/README.md) | Implements the notifier port used by reminder delivery. |
| [retrieval/embeddings](retrieval/embeddings/README.md) | Loads configured embedding artifacts and provides normalized vectors for index building and query retrieval. |

## Cross-cutting changes

- Host payload or hook timing: adapters/codex, cli, capture and retrieval.
- Canonical schema or identity: vault, memories, candidates, migrations and retrieval rebuilds.
- Model output: luna contracts, the consuming worker/quality/governance path, and schema tests.
- Project identity: projects, session migration, capture and explicit recall scope resolution.
- Lifecycle or retention: candidates, capacity, lifecycle, governance, purge and retrieval eligibility.
- Installation or configuration: configuration, integration, operations and both user READMEs.

## Validation and document ownership

Use the focused test commands in each guide, then the repository checks in [AGENTS.md](../AGENTS.md). Model mocks prove contracts and recovery behavior; evaluate real-model knowledge quality separately with authorized samples. Keep test data isolated from installed runtime and Vault directories.

[CONTEXT.md](../CONTEXT.md) defines terms; [SPEC.md](../SPEC.md) records product contracts; [ADRs](../docs/adr/) explain decisions. Verify old ADRs against later decisions and current code. If implementation conflicts with an accepted contract, report the discrepancy rather than silently changing the requirement.
