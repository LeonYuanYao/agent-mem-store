---
status: accepted
---

# Resolve project identity with repository evidence or an explicit marker

MemStore resolves Project Memory against a stable Project identity while keeping the human-facing project key predictable. An existing `.memstore-project` marker is the highest-priority explicit identity for both Git and non-Git directories. The marker contains a stable `project_id`, not a path to another directory; directories declaring the same identifier intentionally share Project Memory.

MemStore never creates, edits, or deletes `.memstore-project` during ordinary capture, injection, Luna processing, indexing, or scheduled governance. A marker changes only when the user edits it directly or explicitly invokes a project-link, unlink, or equivalent Skill operation that clearly authorizes the file write.

ADR-0021 defines the marker as a versioned UTF-8 JSON object with a portable `project_id` and optional presentation-only `display_name`. Invalid or unsupported markers follow the same safe-failure boundary as conflicting resolver evidence.

Without a marker, a Git repository uses the basename of its Git top-level directory as the human-facing project key. Git common-directory identity and normalized remotes act as collision evidence: matching evidence lets same-named worktrees or clones share a project, while materially different evidence must not be silently merged.

Without a marker, each non-Git project root is registered independently in machine-local state and receives its own generated `project_id`, even when another registered directory has the same basename. Registered subdirectories resolve through their nearest or longest matching project root. Moving such a directory may require explicit relinking; a portable identity requires an explicit marker.

Machine-local path aliases and Git fingerprints are resolver state, not Canonical Memory Data. Invalid or conflicting identity evidence fails safely: the active Agent session continues, Global Memory remains available, capture can be retained with unresolved scope, and potentially unrelated Project Memory is not injected. Exact marker schema, path canonicalization, remote normalization, and collision-recovery commands require later review.
