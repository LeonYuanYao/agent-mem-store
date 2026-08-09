---
status: accepted
---

# Use reconciliation-first lightweight Vault writes

MemStore v1 does not add a native macOS content-CAS helper, cross-process file
lock service, or custom file-exchange protocol for the extremely small interval
between the final content check and atomic rename.

Before an Agent revision writes any Vault file, both the caller-observed content
identity and the Runtime catalog identity must match the current Canonical file.
Any unreconciled Obsidian edit stops the Agent revision and goes through Human
reconciliation first. The writer preserves immutable revisions, performs one
last content check immediately before atomic rename, synchronizes the file and
parent directory, and verifies the result before advancing the Runtime catalog.

An interrupted file/catalog update is repaired from Canonical current notes and
immutable revisions through catalog rebuild. If the current note exists but its
matching immutable revision is missing, rebuild recreates that revision from the
current Canonical source before publishing catalog state.

This is a deliberate low-maintenance, never-silently-ignore-human-edits policy,
not a claim of mathematically atomic content compare-and-swap across an
uncooperative external editor. A native helper can be reconsidered only if
observed Bad Cases show that the remaining narrow race is material.
