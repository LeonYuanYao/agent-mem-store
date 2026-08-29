# ADR-0119: Use portable numeric Memory references at Agent boundaries

## Status

Accepted.

## Decision

MemStore keeps the existing `msmem_` UUID as the Canonical internal identity and adds a Vault-wide positive integer `memory_ref`. The portable Agent-facing form is `M:<memory_ref>`.

References are allocated monotonically, never reused, and persisted in both the Runtime reservation ledger and the current Canonical Memory Markdown file. Existing Memories receive deterministic references during migration. Adding a reference is excluded from Canonical semantic content identity, so the migration does not manufacture Human-authored revisions.

Automatic SessionStart and UserPromptSubmit packs render only the portable reference plus compact scope, authority, and representation labels. Project UUIDs and Memory UUIDs do not appear in automatic headers. `S:P` means the resolved current Project and `S:G` means Global. CLI and MCP explicit-recall operations accept either `M:<number>` or the Canonical `msmem_` UUID; responses continue to expose both for audit and compatibility.

The current Canonical Markdown file is the portable source of the reference. Historical revision files may omit it; Runtime resolution supplies the immutable reference when such a revision is read. Import and catalog rebuild preserve existing references and reject collisions or reassignment.

## Consequences

- Agent-visible identity is substantially shorter and easier to copy or request for deep reading.
- Internal joins, provenance, relationships, and migration safety retain UUID collision resistance.
- Numeric references are stable within a migrated Vault, but are not a global identity across independently created Vaults.
- Deleted and tombstoned references remain reserved, producing harmless gaps rather than ambiguous reuse.

This decision supersedes only the identity-rendering details of ADR-0053; its authority and representation labels remain in force.
