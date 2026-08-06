---
status: accepted
---

# Normalize Project resolution with conservative collision handling

The resolver searches from the current directory toward its ancestors for the nearest `.memstore-project` and canonicalizes paths through realpath or equivalent symlink resolution. A malformed or unsupported nearest marker fails safely without falling through to Git, basename, or registered-root guessing. Independently eligible Global Memory remains available.

Without a marker, Git uses the Unicode-NFC, case-preserving top-level basename as its human-facing key and keeps the generated stable identity in the machine-local Registry. Same-basename checkouts automatically share only when their Git common directory matches or their normalized `origin` fetch identity matches. Explicitly different origins remain separate and record a collision; missing or inconclusive evidence requires an explicit marker or management operation.

Remote normalization unifies scp-style SSH, `ssh://`, and HTTPS forms; lowercases host; removes userinfo, default ports, query, fragment, trailing slash, and `.git`; and preserves generic repository-path case unless a versioned provider adapter defines otherwise. Only `origin` fetch identity participates by default so a common `upstream` does not merge forks. Local-path remotes use a realpath-based machine-local identity.

An unmarked submodule recursively inherits the outermost resolved superproject Project. A nearer explicit marker creates submodule-specific identity and one bounded Session operational notice naming the selected and inherited parent Projects and how removal restores inheritance.

For non-Git directories, the resolver chooses the deepest realpath-normalized registered ancestor. If none exists, it registers the current working directory as a new root without creating a marker. Same-basename roots remain separate. Moving an unmarked root requires explicit Registry relinking; an explicit marker provides portable intentional sharing.
