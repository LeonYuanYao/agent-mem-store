---
status: accepted
---

# Keep what the user asked to remember past the verifier's one-off call

ADR-0179 stopped the verifier's `durability` answer, given on each claim alone, from
dropping items the appraisal had kept. Requested runs (`memstore remember extract`,
ADR-0150) are not appraised, so they kept the old rule: an item the verifier called
episodic was dropped although the user had asked to keep the material. The extraction
of a requested run is already told to leave out state that holds only this once.

On 2026-11-19 the user handed the 29 files of Claude Code's auto memory to dreaming
(run `msdream_e723d5cc`). Five rules were dropped as episodic, among them the order of
steps when a MemStore change adds a migration, why `lark-cli --as user` fails in a
botmux scheduled turn, and the commute window when the laptop is offline. Across all
eight requested runs since 2026-10-20, 10 of 44 items were dropped this way, the rest
including the SSH user and host name of the remote Mac mini and the ASpace agent name
of a workspace.

Decision: in a requested run the verifier's episodic call no longer drops an item. The
request stands in for the appraisal. Every other rule still applies: documented knowledge
is dropped, contradicted or stale claims go to review, branch-only claims stay with their
branch.

Evaluation: Codex labeled the 44 items of the eight runs, blind to their tier, as lasting,
one-off or unsure, in four runs. Twelve nightly items the appraisal had called one-off were
mixed into the last two as a control. The 10 items this change keeps were labeled lasting
39 times of 40; the one exception, in one run, was "the SSH public-key login was verified".
The 25 items those runs already injected were labeled lasting every time. Of the control,
5 were labeled one-off in both runs, so the labeler does tell them apart. Replayed, all 10
items are injected (9 `user_requested`, 1 `confirmed`); none is documented or branch-only.
