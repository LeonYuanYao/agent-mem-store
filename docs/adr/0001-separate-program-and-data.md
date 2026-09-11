---
status: accepted
---

# Separate the program from memory data

MemStore Project and Memory Vault have independent ownership and lifecycles. The program lives in its own checkout, while the separately configured Obsidian vault at `<vault-root>` remains the single source of truth for personal memory data. This separation keeps personal knowledge out of the program repository by default and allows the data to be inspected, backed up, and migrated without coupling it to one implementation.

The vault location is machine-local information and must not become a hard-coded portable default. MemStore must not create a second authoritative copy of vault content or modify Obsidian's `.obsidian/` configuration unless a later reviewed specification explicitly requires it.
