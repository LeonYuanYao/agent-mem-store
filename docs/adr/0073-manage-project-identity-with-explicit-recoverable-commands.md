---
status: accepted
---

# Manage Project identity with explicit recoverable commands

The MVP Project surface is:

```text
memstore project status [--path <path>]
memstore project list
memstore project link --path <path> --to <project-id|other-path>
memstore project unlink --path <path>
memstore project relink-root --from <old-path> --to <new-path>
memstore project collisions
memstore project resolve-collision --path <path> --use <project-id>
memstore project resolve-collision --path <path> --separate
```

Status, list, and collisions are read-only and explain final identity and evidence. Link explicitly creates or updates a marker after resolving the target, preserves unknown fields, and only shares identity; it never migrates or rewrites Memory. Resolve-collision uses a selected existing identity or creates a separately marked identity.

Unlink recoverably renames a marker to a timestamped disabled file, previews fallback resolution, and deletes no Memory. Relink-root changes only the machine-local Registry for a moved non-Git root after validating old and new paths and creates no marker.

Every write reports old and proposed resolution, Registry effects, and marker effects and supports `--preview`. The first version exposes no Project merge or Memory migration command.
