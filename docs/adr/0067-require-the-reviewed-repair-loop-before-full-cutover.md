---
status: accepted
---

# Require the reviewed repair loop before Full Cutover

The complete foreground `$memstore-repair` workflow remains outside the Engineering MVP but is a hard prerequisite for Full Cutover. Collecting irrelevant observations and diagnostic bundles is not sufficient once MemStore becomes the sole long-term memory path.

The Skill loads a selected Bad Case or aggregate with its storage locations, occurrence and version history, representative samples, and linked Injection Receipts. It confirms or clearly warns about the required user-started Codex + GPT-5.6 foreground model and supplies the accepted repair objectives, constraints, prohibited silent changes, and evidence expectations. Detection and reminders may run automatically; repair proposals and changes do not run silently in the background.

Before cutover, at least one synthetic irrelevant case must prove record, aggregation, Skill diagnosis, reviewed repair proposal, Bad Case replay, and risk-tier resolution. Class A and B may resolve under their accepted self-test evidence. Class C retains its required runtime observation period and opportunity count.

If the user does not start the Skill, MemStore only records, aggregates, retains, and reminds. It does not invoke GPT-5.6 to repair itself.
