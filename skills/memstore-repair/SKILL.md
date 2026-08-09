---
name: memstore-repair
description: Repair MemStore irrelevant-retrieval Bad Cases through a user-started, two-gate foreground workflow. Use when the user asks to inspect, diagnose, replay, or fix a MemStore Bad Case, irrelevant recall report, ranking regression, or memory safety-boundary failure.
---

# MemStore Repair

Repair one or more stored Bad Cases without exposing raw local data or silently changing the system.

## Preconditions

- Confirm this is a user-started foreground Codex session using GPT-5.6. If model identity is unavailable or different, warn clearly and do not claim the requirement is met.
- Work in the MemStore repository. Do not edit the Obsidian Vault as part of product repair.
- Never commit, push, install, restart components, change global Codex configuration, or resolve a case without separate authority.

## Workflow

1. Run `memstore repair prepare <bad-case-id> --model <active-model> --json` and read the generated bundle. The first phase is read-only.
2. Diagnose the evidence using the categories and evidence requirements in [REFERENCE.md](REFERENCE.md). If the case cannot be reproduced, report missing evidence; do not resolve it.
3. Write a proposal JSON containing `rootCause`, `riskClass`, `diagnosis`, `proposedChanges`, `expectedImpact`, `risks`, `rollbackMethod`, and `verificationPlan`. Run `memstore repair propose <repair-id> --file <proposal.json> --json`.
4. Stop for Review Gate 1. After explicit approval, record it with `memstore repair approve <repair-id> --gate 1 --file <approval.json> --json`. Only edit the exact `authorizedTargets`.
5. Minimize any regression fixture into sanitized synthetic data. Never copy raw Runtime diagnostics into Git.
6. Record the applied version and exact changed targets with `memstore repair applied <repair-id> --file <application.json> --json`.
7. Run targeted tests, offline Bad Case replay, and the protected comparison set. Record truthful results with `memstore repair replay <repair-id> --file <replay.json> --json`.
8. Stop for Review Gate 2. Only after explicit approval run `memstore repair approve <repair-id> --gate 2 --file <approval.json> --json`.
9. Class A/B can resolve only when their required replay evidence passes. Class C enters monitoring; record only actual relevant safety opportunities with `memstore repair observe <repair-id> --file <observation.json> --json`.

At every stop, summarize evidence, unknowns, proposed effects, rollback, and the exact next command. Use temporary files outside the repository or its ignored temporary directory for payloads.
