---
status: accepted
---

# Let appraisal outrank the verifier's durability call

ADR-0177 made a judge model decide, with the rest of a Session's items in view, which
dream items are of lasting value. The verifier still answers its own `durability`
question on each claim alone, defined only as "一次性信息填 episodic", and the tier
dropped every episodic item. So two stages judged the same property, and the weaker
one had the last word. In the runs of 2026-11-17 to 2026-11-19, 15 items appraised
`keep_pitfall`, `keep_usage` or `keep_rule` were dropped as episodic, among them a
recovery command for a stalled kaboo-cli sync, a Lark Base formula that charts reject
unless wrapped in `VALUE`, and the 4 MiB request limit a long PTC session runs into.
ADR-0177 found that a model judging items one at a time cannot tell value apart.

Decision:

- An item the appraisal kept is tiered as if `long_term`; the verifier's episodic
  call no longer drops it. Every other rule still applies: documented knowledge is
  dropped, a single-Session claim the repositories cannot confirm stays in the pool.
- Items that are not appraised (user-stated items, requested runs) keep the old rule.

Replayed on those runs, 2 of the 15 would have been injected (confirmed by the
repositories), 12 kept in the searchable pool and 1 still dropped as documented.

Rejected: tightening the appraisal prompt (2026-11-19). A Codex review of the 38 items
written in those runs judged 14 not worth keeping, 7 of them module internals, and 8
filtered items worth keeping. Two prompt revisions excluded system-internal rules from
`keep_rule`, narrowed the orientation clause of `keep_usage`, compared redundancy across
a batch, and kept failures with a reusable remedy as pitfalls. Replayed on the 502
dreaming Memories of ADR-0177, they kept 52% against 57-58% for two runs of the current
prompt, and items an earlier audit called code details 28-30 against 46-48. But Memories
relevant to a real prompt fell to 40-41 of 50 against 42-45: about one in eight of the
extra drops, close to the one in seven among all kept items. A higher bar, not a better judge.
On the reviewed runs they agreed with the review more often (23 of 29 against 18), but
the revisions were written from that review. The prompt stays as it was.
