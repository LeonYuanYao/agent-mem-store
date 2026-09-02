---
status: accepted
extends: ADR-0012, ADR-0018, ADR-0079, and ADR-0085
---

# Expose preview-first Memory lifecycle controls

MemStore exposes three explicit single-Memory lifecycle controls. `archive` creates a new Canonical
revision, removes the Memory from normal recall, and materializes the configured recovery deadline.
`restore` creates another Canonical revision before body purge, returns the Memory to Active, and
clears the previous archive cycle's timestamps and purge deadline. Both preserve the Memory's
existing authority and body. They preview by default and require an explicit apply flag to write.

Agent integrations expose `memstore_archive` and `memstore_restore` as thin MCP clients of the same
lifecycle core used by the CLI. The tools accept portable `M:<number>` references or Canonical UUIDs.
They do not grant Luna new automatic authority over Human-authored Memory: they are explicit control
surfaces, while automatic governance remains constrained by ADR-0018.

`purge-memory` is a separate CLI-only high-risk control. It accepts only Archived Memory, refuses
`retain_forever`, pin, open review, open verification, and open conflict protections, and requires a
separately verified Vault backup. Preview returns an approval digest bound to the exact Memory body,
revision set, and backup identity. Apply requires that digest and revalidates the target and backup
before replacing the body with the existing minimal Tombstone. The operation may run before the
ordinary retention deadline only because the user explicitly selected and approved that exact
Memory. There is no generic `forget` alias and no MCP physical-deletion tool.

After body purge, `restore` refuses the Tombstone because MemStore no longer has content to recover.
An interrupted single-Memory purge remains idempotently finishable from the verified backup and the
Tombstone's recorded purged identities.
