---
status: accepted
---

# Adopt quality-first Memory Injection budgets

The first version uses one quality-first default budget profile. `SessionStart` retains the accepted 1,200-token Core Memory Pack hard limit and the 600-token `startup: always` ceiling from ADR-0023. A non-empty `UserPromptSubmit` Relevant Memory Pack targets 300–600 rendered tokens, may contain at most six Injection Snippets, limits each snippet to 192 rendered tokens, and has a 1,024-token hard limit. An irrelevant, short confirmation, continuation-only prompt, or prompt whose eligible knowledge is already present in the current context produces an empty pack.

A context epoch starts at a new `SessionStart` and ends only when the host explicitly establishes a new context after compaction or an equivalent lifecycle transition. If an adapter cannot identify that boundary reliably, it must not guess that the budget has reset. The actual rendered SessionStart pack counts toward the epoch total.

Automatic Memory Injection has an 8,192-token soft target and a 12,288-token hard limit per context epoch. Below the soft target, normal eligible Project and Global Durable Memory may compete under the reviewed relevance, authority, scope, diversity, and repetition rules. At or above the soft target, ordinary automatic recall stops: only previously uninjected knowledge that passes a stricter relevance gate and is Human-authored or otherwise explicitly verified and high-authority may use the remaining capacity. The exact ranking weights and post-soft-target score thresholds require Shadow Mode measurement and a later review, but no item, authority level, `startup` policy, warning, or adapter may bypass the hard limit.

The same Memory identity and revision is automatically injected at most once per context epoch. A materially new revision is a new eligible unit, subject to all other filters and the remaining budget. Budget accounting uses the final rendered text, including pack structure, labels, provenance references, and warnings. It uses the target model's tokenizer when available; a conservative documented estimate is required otherwise.

Explicit deeper retrieval through MCP or the Memory Skill defaults to 4,096 rendered tokens per invocation and has an 8,192-token hard limit per invocation. It is not charged against the automatic 8,192/12,288-token epoch budget, but it remains part of the host context and account usage. Results must support pagination or continuation by Memory identity. A foreground Hook cannot relabel automatic retrieval as explicit retrieval to bypass an automatic limit.

Quota pressure does not silently reduce these defaults in the first version. When an available host usage window crosses 70%, MemStore emits one bounded advisory; crossing 85% emits one bounded urgent advisory. These notices contain no Memory bodies and do not change authority, ranking, or budgets. Any conservative mode or automatic quota-based degradation requires a separate explicit user decision.

Injection Receipts record the rendered token count, automatic epoch total, budget tier used, selected Memory identities and revisions, omitted-over-budget identities, and whether the result was empty, soft-target-restricted, or hard-limit-blocked. Shadow Mode compares at least 4,096, 8,192, 12,288, and 16,384-token candidate epoch ceilings and reports necessary-knowledge recall, irrelevant injection, high-authority truncation, explicit follow-up retrieval, cache behavior, estimated or observed credit impact, and task outcomes before Controlled Cutover.

These defaults favor recall quality for the user's Codex Pro 20x workload without treating subscription allowance as a fixed or unlimited raw-token pool. Individual values remain explicitly configurable, but usage statistics, Luna, scheduled governance, and adapters cannot change them silently.
