---
status: accepted
---

# Quarantine suspected Secrets without retaining bodies

Sensitivity Quarantine is a body-free eligibility and audit state, not a second store for suspected Secret content. It persists only a Quarantine identity, Project, Session or Turn identities where available, source kind and safe locator, non-reversible fingerprint, detector rule and version, risk category, bounded reason, timestamps, source availability, and lifecycle state. It never retains the suspected value or a reversible excerpt.

When an original source such as a Vault or ordinary file remains readable, the record binds its safe locator and content identity so a later local detector version or explicit review can re-read the current source in place. MemStore does not copy the body. If an ephemeral Prompt, Tool output, or unstable transcript cannot be re-read, the body is intentionally lost. A later false-positive decision requires explicit resubmission of safe content.

Outcomes are `confirmed_secret`, `false_positive`, `sanitized_replacement`, or `discarded`. Confirmed Secret retains at most a body-free rejection fingerprint or tombstone. False positive follows the exact override contract and reprocesses only a still-readable matching revision. Sanitized replacement creates a new independently screened Candidate. Discarded metadata follows its retention policy.

Background Quarantines are aggregated into the accepted Review Inbox and body-free notification flow. An explicit remember operation immediately returns its Quarantine identity, risk category, no-body-retained state, and available review or safe-resubmission action.

A detector-rule change may locally rescan a still-readable unchanged source. It cannot infer safety from historical metadata, send suspect content to Luna, or recover an unavailable body. Luna, governance, and metrics cannot approve a false-positive override.
