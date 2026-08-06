---
status: accepted
---

# Defer application-level encryption

The first MemStore version does not implement application-level, field-level, note-level, or Vault-wide encryption. Canonical Memory Data remains ordinary human-readable Markdown so Obsidian viewing, manual editing, backup, and migration do not depend on MemStore keys or a MemStore decryption runtime.

MemStore also does not introduce key generation, key storage, recovery phrases, automatic decryption, or encrypted-note formats in the first version. Private Memory is therefore plaintext within the user's Vault protection boundary. Secret Content remains prohibited from persistence under ADR-0013; absence of encryption is not permission to store credentials.

Machine-local Durable Outbox, Governance Ledger, indexes, caches, and logs use restrictive filesystem permissions and the same Secret-redaction rules, but MemStore must not describe permissions, FileVault, storage-provider encryption, or Obsidian Sync encryption as application-level encryption that it provides or controls.

Adding encryption later requires a separate reviewed ADR covering threat model, key ownership and recovery, Obsidian usability, sync and backup behavior, schema versioning, migration and rollback, search and injection over encrypted content, and failure recovery. No first-version format should imply that future encryption can be added transparently without migration.
