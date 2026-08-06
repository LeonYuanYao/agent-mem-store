---
status: accepted
---

# Require six explicit SDD Review Gates

MemStore delivery uses six explicit human Review Gates. Approval authorizes only the next named phase and never implicitly authorizes later code, global installation, Shadow, or Full Cutover.

1. **Spec Sign-off** authorizes only creation of the Implementation Plan.
2. **Implementation Plan Review** covers architecture, schemas, interfaces, dependencies, phases, effects, risks, rollback, and evidence, and authorizes repository-local Core Foundation work.
3. **Core Foundation Review** covers configuration, Project resolution, SQLite, Outbox, replay, Secret containment, Canonical read/write, separation, and isolated fault tests, and authorizes the rest of Engineering MVP implementation.
4. **Engineering MVP Review** covers the complete uninstalled Shadow data loop, Luna, Candidate lifecycle, Canonical data, indexes, recall, MCP, Skills, governance, Review UX, recovery, portability, and failure tests. It delivers a global-integration preview and authorizes repository-local Gate 5 prerequisite work. Managed development Shadow installation occurs only when explicitly included; it does not start the official window.
5. **Full-Cutover-Prerequisite Review** covers tested purge, the foreground repair loop, cutover and rollback rehearsal, managed integration preservation, and a frozen candidate configuration. It starts the official seven-day Shadow window; earlier development data is not counted.
6. **Seven-day Readiness and Full Cutover Review** examines the complete Readiness Report and may authorize one Full Cutover.

Post-cutover checks cover new and supported existing Sessions, Hooks, MCP, injection, fail-open behavior, and rollback readiness. Critical failure follows the prevalidated rollback path without deleting either memory store.

Global Codex configuration, Skills, MCP, Hooks, LaunchAgent, Shadow, and Full Cutover always require their named authorization. Repository implementation never implies commit, push, PR/MR, release, or publication. Reviews use fresh evidence, and destructive tests with shortened retention remain isolated from the real Vault.
