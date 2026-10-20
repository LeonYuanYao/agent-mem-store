---
status: accepted
---

# Apply dreaming's inject tier to canonical Memory

Shadow dreaming (ADR-0147) ran for a week. A Codex review (gpt-6.1-sol, checked
against the repositories) of 31 inject-tier items from the four nights after the
2026-10-15 fixes found 84% correct or already documented, 6% redundant with
guidance agents already read, 10% partially wrong or branch-only, and 71% worth
injecting (the two nights before the fixes: 75%, 20%, 10% and 52%). Injection was
still limited to Human-authored Memory, and every earlier agent-derived Memory
had been purged.

Decision: with `[dreaming].mode = "apply"`, inject-tier items become canonical
Memory. Branch, pool, review and drop tiers stay in runtime tables and reports.

- Authority stays `agent_derived` with `origin_kind = model_extraction`; the
  policy version `dreaming-v1` marks dreaming Memory. A new authority value would
  touch CHECK constraints and about thirty authority queries, and nothing else
  needs to treat dreaming Memory differently.
- The body is the verified (refined) statement, used verbatim as the compact and
  standard representations; the verifier's subsystem becomes the applicability
  summary; provenance records the run and item, Sessions and evidence. Categories
  follow the claim type. Startup is `auto`.
- Global Memory needs global intent (ADR-0006): only the user's own lasting rule
  is written globally; other global items stay with their Project.
- Before writing, each item is compared with the six textually closest active
  Human-authored and dreaming Memories in its scope, passages of the user-wide
  instruction files every session loads (`[dreaming].host_instruction_files`,
  treated as Human-authored), and earlier items of its batch; the dreaming model
  (no tools) decides new, duplicate, refines or conflicts. A refinement replaces
  the earlier statement rather than merging both. Human-authored Memory always
  wins: a duplicate is skipped and a
  contradiction is listed for review, never written. A duplicate of dreaming
  Memory counts an observation; a refinement or contradiction revises it. The
  same statement found again counts an observation without a model call, and a
  rolled-back statement is not written again.
- A later review-tier item stating a dreaming Memory marks it `review_due`, which
  automatic injection already excludes for agent-derived Memory.
- `[adapters].dreaming_injection = true` lets automatic injection admit dreaming
  Memory while `human_authored_only_injection` keeps excluding all other
  agent-derived Memory. Retrieval documents record the policy version for this.
- `memstore dream apply --from DATE [--preview]` applies or previews completed
  runs; `memstore dream rollback [RUN_ID] [--apply]` archives dreaming Memory
  recoverably. Turning `dreaming_injection` off stops injection without touching
  Memory.

Rejected: a dedicated authority value (cost above, no behavioural need);
writing every tier with retrieval filters (branch-scoped retrieval does not exist
and the pool is low value for automatic injection); vector duplicate detection
at write time (needs the embedding adapter in the dreaming step and still needs a
model to tell refinement from duplication).

Consequences: dreaming Memory is subject to agent-derived governance and
capacity. Canonical writes refuse while the configuration runs on its
last-known-good copy, so apply checks first and leaves the batch pending until
the configuration is current; failed items are retried by `memstore dream apply`. With Luna distillation disabled while dreaming is enabled, dreaming is
the only source of new agent-derived Memory. A global fact first seen in one
Project is not promoted when other Projects confirm it; that needs a later
decision. Long statements (over 96 estimated tokens) have no validated compact
and are injected only through the standard representation on the prompt path.
