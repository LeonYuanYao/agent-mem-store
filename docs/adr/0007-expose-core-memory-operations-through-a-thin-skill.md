---
status: accepted
---

# Expose core memory operations through a thin Skill

MemStore provides stable core operations for remembering supplied content, extracting knowledge from a targeted source, changing an existing memory's scope, and inspecting operation status. A repository-managed Agent Skill exposes these same operations through an intentional natural-language workflow for Codex and other compatible Coding Agents.

The Skill is a thin orchestration layer, not a second implementation of memory processing. It selects the requested source and Project or Global scope, invokes the canonical MemStore command or API, and reports the returned operation or memory identity. Durable capture, Luna invocation, idempotency, validation, conflict handling, and Vault writes remain in the MemStore core and background worker.

The Skill defaults to Project scope. It selects Global scope only when the user's invocation explicitly requests it; Luna must not infer that authorization. It supports explicitly supplied content as well as targeted extraction from the current turn, selected content, or current session. It must report failures truthfully and must not claim that memory was stored merely because an Agent produced a summary.

One Skill supports both Project and Global workflows to keep triggering rules and maintenance centralized. Its canonical source belongs to the MemStore Project and can be exposed to supported Agents through installation or repository-backed links without copying personal Memory Vault data. ADR-0016 resolves direct-assertion authority; the final Skill name, trigger description, host installation mechanism, preview behavior, and wait semantics require later review.
