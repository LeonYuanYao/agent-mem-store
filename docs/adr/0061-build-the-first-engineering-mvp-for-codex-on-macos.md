---
status: accepted
---

# Build the first Engineering MVP for Codex on macOS

The first Engineering MVP targets one user on macOS with the locally installed Codex and configured Obsidian Vault. Core domain, storage, retrieval, and host-adapter contracts remain host-neutral, but this milestone implements and validates only the Codex lifecycle adapter and macOS integration.

A Claude adapter is a later explicit milestone after the Codex path is stable. It reuses the same core and adds host-specific capture and injection behavior. It does not block Codex Shadow validation or Full Cutover.

The MVP does not implement two lifecycle adapters in parallel merely to claim multi-Agent support. Every later adapter must prove its lifecycle semantics, capture completeness, injection compatibility, latency, and fail-open behavior before activation.
