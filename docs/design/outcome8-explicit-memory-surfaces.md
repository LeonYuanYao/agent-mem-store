# Outcome 8 explicit-memory surfaces

Status: review candidate; repository-local and uninstalled.

## One application core

CLI Recall commands and the five stdio MCP tools normalize into
`src/operations/recall.ts`. This keeps scope, authorization, eligibility,
pagination, receipts, progressive reads, and irrelevant reporting identical.
MCP stdout is reserved for protocol messages; startup diagnostics use stderr.

Remember commands normalize into `src/operations/remember.ts`:

- `assert` creates an exact Direct Human Assertion without Luna rewriting;
- `extract` binds captured evidence to a durable Luna distillation batch and
  creates Agent-derived Candidates;
- Project and `startup:auto` remain the defaults;
- Global scope must be explicit;
- Codex `selection:<id>` fails with `unsupported_selection_identity`;
- preview performs no Registry, Runtime, Vault, Luna, index, or audit mutation;
- wait observes durable work and never cancels it on timeout.

All JSON entry points use a versioned `{schema_version, ok, command, ...}`
envelope. Internal queue phases are mapped to the accepted public operation
states while retaining a diagnostic `phase` field.

## Project and status safety

`project status`, `project list`, `project collisions`, `operation status`, and
top-level `status` use read-only SQLite handles and do not update `last_used_at`
or register a directory. Marker updates preserve unknown future fields and use
content-identity compare-and-swap. Unlink renames the marker to a timestamped
disabled file instead of deleting it.

## Skills

`skills/memstore-remember` and `skills/memstore-recall` are thin routing and
interpretation guides. They never implement a second persistence or retrieval
engine and are intentionally not installed during Outcome 8.

## Deliberately inactive

Outcome 8 does not install Hooks, MCP configuration, Skills, LaunchAgents, or
model artifacts. It does not write a real Obsidian Vault, run scheduled
governance, inject context, or replace Codex native memory. The approved
E5-base q8 profile remains a non-activated Shadow candidate.
