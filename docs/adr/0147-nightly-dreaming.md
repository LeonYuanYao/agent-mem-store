---
status: accepted
---

# Replace per-turn distillation with nightly dreaming

Per-turn distillation calls Luna once per Turn and again per Candidate. In one
week of one Project it made about 630 model calls, and an independent Codex
review of a random sample of the resulting active memories found 25% correct and
non-redundant, 27.5% already stated in auto-loaded guidance, 15% true only on an
unmerged branch and 7.5% partially wrong. Nothing checked memories against the
repository before injection.

An offline experiment on the same week (19 Sessions, 151 Turns) compared
alternatives with Codex-only evaluation (gpt-6.1-sol labels and a 130-item gold
set checked against the repositories):

- Cross-session synthesis alone produced 13 items and covered 6 of 124 useful
  per-turn memories.
- Session extraction from prompts and replies only covered 21%; about 70% of the
  missed knowledge appeared only in tool output.
- Session extraction in 150k-character chunks with bounded tool output covered
  about 78% of the union of useful knowledge (per-turn: 43%) with 86 calls.
- A verifier reading baselines through `msverify`, with source-authority ranks,
  deterministic pre-search and a defense pass (Luna high) confirmed with 90%
  precision; `xhigh` and `max` did not improve quality and cost about 20% more.
- Inferring the Session's branch and scoping unconfirmed knowledge to unmerged
  branches caught 6 of 8 branch-only memories that the model alone missed.
- The resulting inject tier, sampled against the gold reviewer, was 75% correct
  or documented with 12.5% harmful, against 52.5% and 22.5% for current memory.

Decision: when `[dreaming].enabled` is true, captured events go to a nightly run
instead of per-turn distillation. The run extracts per Session chunk, merges per
claim type, verifies against repository baselines, runs a defense pass on
negative verdicts and tiers each item: inject (confirmed, user-stated or
recurring), branch, searchable pool, review or drop (episodic or already in
auto-loaded guidance). Capture continues while human-only injection is on,
because dreaming needs Sessions; injection authority is unchanged.

The first release is shadow-only: it writes a Vault report and runtime tables
and never writes canonical Memory. Apply mode, retrieval of the branch and pool
tiers, and a Claude Code capture adapter are separate decisions after reviewing
shadow reports.
