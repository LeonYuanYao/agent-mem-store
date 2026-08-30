# ADR-0121: Bound Automatic Agent Memory per Memory Space

## Status

Accepted.

## Context

Foreground retrieval is bounded and indexed, but an indefinitely growing automatic candidate pool raises ranking cost and noise. A single Project may have several local roots, so capacity follows Project identity rather than checkout layout.

Age or least-recent use cannot justify deleting durable knowledge. Rare constraints may matter, Human-authored knowledge is authoritative, and Phase 0 replay found that model-driven cold rescue still introduced unacceptable foreground noise.

## Decision

MemStore separates the complete durable corpus from a bounded automatic-ranking working set. Each Project identity has one shared working set; Global is separate. Human-authored Memory is exempt.

| Space | High water | Hard limit | Low water |
| --- | ---: | ---: | ---: |
| Project | 2,500 | 3,500 | 2,200 |
| Global | 300 | 500 | 270 |

The recent-activity window is seven days. Above high water, local deterministic reconciliation keeps hard-protected and recent Agent-derived Active Memories, then fills to low water by descending activity, soft-signal tie-breakers, and Memory identity.

The result is stored as a machine-local exclusion bound to an exact Memory revision. It does not change canonical Markdown or lifecycle. A revision, authority/lifecycle/scope change, explicit selected read, or later rebalance can restore an entry.

Hard protection covers explicit pins/retention, `startup: always`, open conflict/verification/review work, and controlled safety, recovery, and preference categories. Model-derived importance, evidence, relationships, priority, and generic negation metadata are soft tie-breakers only.

SessionStart and UserPromptSubmit use the working set. Explicit search, identity, related, provenance, MCP, and Skill retrieval use the complete Active corpus. Automatic cold rescue is disabled. Foreground snapshot refresh reuses existing documents and vectors and invokes no model or embedding build.

At the ranked hard limit, ordinary Agent Candidate promotion waits. Capacity work is local and independent of Weekly/Monthly model governance. Missed wake-ups and publication failure remain recoverable within six hours; publication failure safely leaves the prior larger set active.

Capacity never archives or deletes knowledge. Durable-corpus reduction is a separate reviewed process requiring a successor, correction/invalidation, source-first transient proof, explicit user action, or future atom-preserving consolidation.

## Consequences

- Automatic foreground cost is bounded without imposing a deletion quota on durable or Human-authored knowledge.
- Explicit retrieval can recover excluded knowledge and make it recent again without a Vault revision.
- Hard-protected entries may keep a space above low water; the system reports this rather than weakening protection.
- Rebalancing uses zero model tokens and performs no embedding rebuild.
- Rollback deletes exclusions and republishes the full snapshot; no canonical restore is required.
- Threshold and protection changes remain explicit reviewed policy changes.
