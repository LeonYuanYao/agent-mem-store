---
status: accepted
supersedes: timeout limits in ADR-0114, ADR-0116 and ADR-0135
---

# Extend Jev and foreground timeouts

Recent receipts showed both successful Jev filtering and repeated timeout
fallbacks. Some calls had reduced time after local retrieval; others exhausted
the former 600 ms stage limit. Existing evidence does not isolate provider,
transport or local scheduling as the root cause. The user explicitly approved
increasing Jev to one second and the total foreground deadline to 1.5 seconds,
then approved a 1.3-second Jev limit for further observation under ordinary traffic.

Jev's default and maximum configured timeout become 1,300 ms. The foreground
client's default absolute deadline becomes 1,500 ms. The existing two-second host
Hook timeout and 200 ms receipt/delivery reserve remain unchanged. Jev still uses
the smaller of its configured timeout and the remaining foreground time minus
that reserve, including configuration, credentials, transport and body parsing.
Previously configured shorter timeouts remain valid until explicitly changed.
With a 1,500 ms foreground deadline, local retrieval and the reserve reduce the
actual Jev allowance below 1,300 ms; the configured ceiling is not a guaranteed
transport budget.

No retry, cooldown, threshold, model, eligibility or fallback rule changes.
SessionStart still does not call Jev. Background Luna and explicit Terra recall
keep their independent policies. Optional receipt diagnostics distinguish the
limiting budget, whether fetch was invoked and the last stage reached; they do
not prove provider receipt or diagnose attempts without a committed receipt.

The larger allowance can recover useful responses beyond the old deadline, but
also increases the wait before unsuccessful calls fall back. It does not establish
a quality improvement or resolve the timeout cause. The p95 300 ms target remains
an observation target. Deterministic transport tests cover a response after
one second, cancellation at the configured limit and reduced time with the reserve;
IPC tests cover successful delivery beyond the old one-second client limit.
Operational assessment uses ordinary traffic, without new live model experiments.
