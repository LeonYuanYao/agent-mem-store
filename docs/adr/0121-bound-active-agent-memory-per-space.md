# ADR-0121: Bound Active Agent Memory per Memory Space

## Status

Accepted.

## Context

Foreground retrieval is now bounded and indexed, but an indefinitely growing Active knowledge pool still raises ranking cost, duplicate-governance cost, and the chance that weak old knowledge competes with useful current knowledge. A single repository may have several local roots, so a directory-based allowance would also make capacity depend on checkout layout rather than knowledge scope.

A hard least-recently-used eviction rule would be unsafe. Rare constraints, negative rules, relationship anchors, user-protected knowledge, and unresolved review work may be important despite infrequent retrieval. Human-authored knowledge remains the highest authority and must not be silently displaced by a machine quota.

## Decision

MemStore applies capacity to a Memory Space: one Project identity, shared by all roots that resolve to it, or the separate Global scope. Only Active Agent-derived Durable Memories count. Human-authored Memory, Candidates, Archived Memory, and Tombstones do not count.

Portable policy starts with these values:

| Space | Soft target | Hard limit | Low water |
| --- | ---: | ---: | ---: |
| Project | 2,500 | 3,500 | 2,200 |
| Global | 300 | 500 | 270 |

The cold window is 180 days and one capacity-governance page contains at most 50 Memories. Crossing the soft target creates a durable recoverable obligation and schedules bounded governance independently of the ordinary Weekly cursor. Work continues toward low water so a small amount of subsequent growth does not immediately retrigger governance.

At the hard limit, ordinary Agent-derived Candidate promotion waits. Capture, distillation, Candidate retention, Human-authored writes, existing recall, and explicit retrieval remain available.

Capacity-only archival may consider only cold Agent-derived Active Memory. Local rules protect Human authority, pins, `retain_forever`, `startup: always`, every controlled importance tag, relationships, high-value or multiple independent evidence, open Verification or Review work, and recent revision or retrieval. A completed, directionally unambiguous duplicate/subsumption review creates a narrower successor-preserving path: its redundant side may be superseded immediately when its protection consists only of importance, high-value, or multiple-evidence signals, because the exact reviewed successor remains Active. Pins, explicit retention, startup placement, relationships, open review work, and recent selected retrieval still block this path.

Luna receives only a bounded capacity shortlist with local eligibility and reviewed-successor signals and may propose `archive_for_capacity` or `supersede_for_capacity`. Deterministic code revalidates the target and any successor both when accepting the model response and immediately before applying it. A capacity-only run rejects ordinary semantic archive, relationship, review, and purge actions so the model cannot disguise eviction as another governance operation.

A capacity action archives rather than deletes. It records a recoverable revision and enters the existing archive-retention and purge lifecycle. If no sufficient safe set exists, the obligation remains pending and becomes visible through status and the body-free Review Inbox. Neither runtime metrics nor Luna may alter thresholds or weaken eligibility rules.

## Consequences

- Capacity follows knowledge identity rather than the number of local checkouts.
- Foreground search and governance have a bounded long-term Active working set without imposing a quota on Human-authored knowledge.
- The system may temporarily remain above target or hard limit when safe cleanup is unavailable; in that case new ordinary Agent promotion waits instead of evicting protected knowledge.
- Archived content continues to consume Vault storage during its retention period, but it stops participating in normal recall and Active ranking immediately.
- Threshold changes remain explicit reviewed policy changes. A future replacement or migration policy can build on stable Project identities without changing this capacity model.
