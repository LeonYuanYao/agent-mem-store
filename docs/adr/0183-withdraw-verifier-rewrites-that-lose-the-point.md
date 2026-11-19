---
status: proposed
---

# Withdraw verifier rewrites that lose the original's point

When the evidence supports only part of a claim, the verifier returns `refined_statement`, a
narrowed rewrite that is tiered and written in place of the claim. The prompt allows this only
when the evidence supports the claim's core. The verifier does not keep to that: it often
replaces the claim with another fact it found in the code. On 2026-11-19, re-extracting
Claude Code's auto memory, "when a MemStore change adds a migration, stop the worker and apply
it before building" was written as the steps of a 2026-09 activation for migrations 0050/0051,
and "Codex has no name-level skill visibility; disable a skill with `enabled = false`" as the
four skills one `config.toml` disables.

Codex labeled all 610 rewrites in the runtime (of 4,168 dream items since 2026-10) by whether
the rewrite still says what the original said. 230 (38%) did not, among them 63 of the 226
written as Memory and 62 of the 142 rewrites of user-stated items.

Decision: after verification, the judge model compares each rewrite with its original
(`checkRefinements`, up to 30 pairs per call, no shell). A rewrite that no longer says what the
original said is withdrawn: the original stands, and since the evidence was about something
else, its verdict becomes `inconclusive` (`not_repo_verifiable` stays) with `branch` and
`documented_at` cleared. The verdict keeps the withdrawn rewrite, its verdict and the judge's
reason, and the report shows the rewrite. When unsure the judge keeps the rewrite.
`[dreaming] check_refinements = false` turns the check off.

Evaluation, on the 610 historical pairs with a check prompt written apart from the labeling
prompt: the check withdrew 170 of the 230 rewrites labeled as losing the point and 10 of the 380
labeled as keeping it; most of those 10 dropped one of the original's points, such as checking
MR state with bytedcli. Among rewrites that stand, the share that lost the point falls from 38%
to 14%. Re-tiered, of the 56 withdrawn items that were injected, 31 move to the pool (not
written), 18 wait with their unmerged branch and 7 are still injected, now as originally stated
(requested runs and user-stated items, the two rules above among them); 26 items dropped as
documented and 12 sent to review move to the pool. A rewrite that loses the point was never
appraised for lasting value; the original was.

Rejected: tightening the verifier prompt alone (rule 8: a rewrite must remain the same piece of
knowledge; evidence about another process or instance leaves the claim unrewritten). Replayed on
60 historical items, 30 of each label, with the old and the new prompt, it halved the rewrites
(24 to 12) but the share that lost the point barely moved (12 of 24 to 5 of 12): a lower rate of
rewriting, not a verifier that tells a narrowing from a swap.
