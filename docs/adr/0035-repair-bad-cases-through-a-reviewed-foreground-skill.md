---
status: accepted
---

# Repair Bad Cases through a reviewed foreground Skill

Bad Case repair is initiated explicitly by the user through a foreground Skill named `$memstore-repair`. The Skill accepts one or more Bad Case identities or an aggregate signature and loads the associated diagnostic bundles, SQLite lifecycle state, and current MemStore code and configuration versions.

The workflow requires a user-started Codex + GPT-5.6 repair Session. A Skill cannot switch the active model itself. If it cannot confirm the model identity, it emits a clear warning and does not claim that the GPT-5.6 requirement is satisfied.

The first phase is read-only. The repair Agent distinguishes evidence for extraction-Prompt failure, importance-classification error, retrieval-ranking error, threshold error, instrumentation gap, source-data quality problem, and incorrect knowledge content. It creates the Repair Bundle with diagnosis, proposed changes, reproduction material, and a verification plan. If it cannot reproduce the issue, it records `not_reproduced` and missing evidence rather than marking the case resolved.

Review Gate 1 requires explicit user approval of the evidence-backed root cause, proposed files and behaviors to change, expected impact, risks, rollback method, and verification plan. Only then may the Agent edit the authorized MemStore Project code, Prompt, configuration templates, or tests. A Memory Vault content correction is a separate explicit Memory operation and cannot be smuggled into product repair.

Any repository regression fixture derived from a real Bad Case is minimized, sanitized, and synthetic. Raw local diagnostic payload remains in Runtime Data and does not enter Git history. The repair then runs targeted tests, Bad Case offline replay, and required Shadow comparison and reports both improvement and newly introduced harm.

Review Gate 2 requires explicit user approval before activating a changed Prompt, ranking rule, threshold, or runtime configuration and before making the final Bad Case lifecycle decision. The Skill cannot automatically commit, push, install global Hooks, restart active components, modify Codex global configuration, or mark the case resolved. Those actions require their own authority and evidence where applicable.

The exact evidence required to distinguish an applied fix from a resolved Bad Case remains a separate reviewed decision.
