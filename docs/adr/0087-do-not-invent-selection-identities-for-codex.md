---
status: accepted
---

# Do not invent selection identities for Codex

The first Codex adapter resolves `current-turn`, `current-session`, and recorded `turn:<id>` from MemStore-owned lifecycle identities. It resolves explicit files after normal path and scope validation.

The verified Codex host exposes no stable native arbitrary-selection handle. Its adapter therefore rejects `selection:<id>` rather than inventing a fragile source identity or silently switching sources. User-provided text uses direct assertion input or extraction from the current turn or an explicit file.

The canonical selector remains reserved for a later adapter that can mint a stable, source-bound selection identity. Adapter capability differences are explicit while the core result and authority contract remains shared.
