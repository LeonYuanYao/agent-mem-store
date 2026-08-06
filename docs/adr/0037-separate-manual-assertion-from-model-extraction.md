---
status: accepted
---

# Separate manual assertion from model extraction

MemStore exposes two explicit core capture operations:

```text
memstore remember assert --scope project|global --text <content>
memstore remember extract --scope project|global --from <turn|session|turn-id|selection>
```

`assert` preserves the user-supplied body as a Direct Human Assertion. `extract` asks Luna to distill the targeted source into Agent-derived Memory Candidates. Selecting a source or Global scope for extraction does not grant Human-authored content authority.

Project is the default scope. Global requires an explicit user phrase or `--scope global`; neither the Skill, Luna, current repository, nor content similarity can infer Global authorization.

The repository-managed capture Skill is named `$memstore-remember`. An exact statement accompanied by an explicit remember or save instruction maps to `assert`. Requests to extract, distill, or summarize a Turn, Session, turn identity, or selection map to `extract`. Ambiguous intent fails toward the lower-authority `extract` Candidate path instead of accidentally creating Human-authored Memory.

When sensitivity, scope, and Human Conflict checks permit, `assert` may complete without an additional preview. `extract` enters the durable background worker pipeline and immediately returns a traceable operation identity and `queued`, `completed`, `retrying`, or `blocked` state. It does not block the foreground Session on Luna by default.

`--preview` and `--wait` are explicit optional modes rather than routine approval requirements. They cannot bypass durable capture, deduplication, provenance, sensitivity, scope, conflict, or promotion rules, and pending work cannot be presented as completed persistence. The Skill remains a thin natural-language adapter and never calls Luna or writes Memory Vault independently.
