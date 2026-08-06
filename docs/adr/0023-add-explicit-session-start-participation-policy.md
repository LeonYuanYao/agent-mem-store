---
status: accepted
---

# Add an explicit SessionStart participation policy

Each Durable Memory may declare a user-controlled `startup` policy with exactly one of three values: `always`, `auto`, or `never`. An omitted policy defaults to `auto`. An invalid value makes that Memory ineligible for SessionStart injection until the metadata is corrected and produces a bounded validation warning; it does not weaken independent Secret, scope, lifecycle, or conflict filters.

`always` gives an otherwise eligible Memory priority when MemStore assembles the SessionStart Core Memory Pack. The Core Memory Pack has a 1,200-token hard limit, including its structure, labels, references, and warnings. Content attributable to `always` items may consume at most 50% of that limit, or 600 tokens, so at least half of the pack remains available for automatically ranked Project and Global knowledge. Unused `always` capacity may be used by those dynamic items, but `always` content cannot use their reserved half.

`always` does not bypass active-state, sensitivity, scope, applicability, conflict, item-count, or token-budget rules and does not guarantee inclusion when the eligible `always` set exceeds 600 tokens. Over-budget omission is deterministic and produces a bounded, persistent validation status until the condition changes or is resolved. The condition is not repeated on every prompt, so MemStore does not silently imply that every requested item was injected or create a foreground notification loop.

`auto` delegates SessionStart participation to the reviewed ranking and diversity policy. `never` excludes the Memory from SessionStart only; the Memory remains eligible for ordinary `UserPromptSubmit` relevance retrieval, explicit MCP or Skill lookup, and governance when all other rules permit it.

The setting is part of Canonical Memory Data so it remains human-readable, manually editable, and portable with the Memory Vault. Direct user edits and explicitly authorized manual commands or Skills may change it. Luna, usage statistics, Injection Receipts, and scheduled governance may propose a change but cannot silently alter an explicit user setting.

The policy applies to both Project and Global Memory. The 1,200-token Core Memory Pack limit and 600-token `always` ceiling are accepted above. Exact ranking weights, diversity rules, candidate-pool sizes, and the dynamic Project-to-Global allocation remain separate reviewed decisions rather than being implied by `startup`.
