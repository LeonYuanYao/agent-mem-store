---
status: accepted
---

# Default to project scope and require global intent

Agent-derived knowledge captured inside an identifiable project defaults to Project Memory. A conclusion from one project must not become Global Memory merely because it appears reusable. A session without a reliable project identity does not implicitly authorize global scope; its extracted knowledge remains unresolved until scope can be established.

Global scope requires either an explicit user directive or corroborating evidence from at least two independent projects with no material conflict. MemStore must provide convenient manual commands that let the user target specific content, ask Luna to distill it, and explicitly select global scope. Such a command is authoritative for scope, while Luna remains responsible for faithful distillation in the background worker. The command does not remove provenance, conflict handling, sensitive-data checks, or the distinction between a direct human assertion and model-inferred content.

ADR-0022 defines independence by Project identity and source provenance, excludes conclusions echoed from prior Memory Injection, and requires a new Global Candidate rather than mutating a source Project Memory in place.

Within a project, applicable Project Memory takes retrieval precedence over Global Memory. This precedence does not overwrite, demote, or silently edit the Global Memory; both memories retain their scope and provenance so a later governance process can resolve any genuine conflict.

Manual commands use the same durable, idempotent processing pipeline as hook capture and return a traceable operation or memory identity. Exact command names, host-specific aliases, preview behavior, and synchronous-wait options require later review.
