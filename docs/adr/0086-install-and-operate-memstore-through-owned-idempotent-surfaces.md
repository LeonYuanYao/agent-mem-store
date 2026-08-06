---
status: accepted
---

# Install and operate MemStore through owned idempotent surfaces

The first version exposes bounded command families for initialization, status and diagnosis, Codex integration, Worker control, operation inspection and retry, governance, Review Inbox work, and Vault-only portability. Remember, recall, and Project commands retain their dedicated accepted contracts. Internal `memstore mcp serve` and `memstore hook codex <event>` entrypoints are stable adapters rather than duplicate business logic.

Codex installation managed-merges MemStore-owned `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, and `SessionEnd` entries, one MCP registration, and global `$memstore-remember` and `$memstore-recall` Skill links. It neither adds `PreToolUse` nor invokes Luna inside Hooks. Existing Hooks, plugins, MCP registrations, order, state, and unknown fields are preserved.

Canonical Skills remain in the MemStore Project and use managed global symbolic links under `~/.agents/skills`. Install, repair, and uninstall act only on entries whose ownership and expected target match. They never delete Memory Vault, Runtime Data, unrelated configuration, or user-modified files.

Integration writes use revision compare-and-swap, atomic replacement, a recoverable timestamped backup, and parse plus ownership verification. Concurrent edits abort with a fresh diff. Strict preview creates no backup, manifest, symlink, or configuration change.

Doctor is diagnostic, not repair. Operation retry cannot bypass Secret or Review gates, and no generic cancel silently discards captured work. Governance uses the same durable obligations as scheduling. Review actions are type-checked. Portability follows the accepted drained long-term-knowledge handoff and never merges Runtime databases.

All meaningful mutations support strict preview and stable JSON. RFC 3339 timestamps, ISO 8601 durations, opaque IDs, query-bound cursors, and validation-before-acceptance apply across families.
