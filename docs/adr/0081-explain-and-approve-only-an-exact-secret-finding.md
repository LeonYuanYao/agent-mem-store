---
status: accepted
---

# Explain and approve only an exact Secret finding

The false-positive capability exists only to correct a Secret detector that blocked known benign content. MemStore says what risk category caused the block and where the original local source can be inspected; it never claims that its own detection is known to be wrong.

The primary action is labeled `I confirm this is not a password or credential; allow only this version`. The surface warns uncertain users to submit sanitized content instead. Other outcomes confirm Secret, submit a sanitized replacement, or discard. Manual remember returns the Review identity immediately; background findings use the non-interrupting Review Inbox and aggregate notification flow.

Approval requires re-reading the same source content locally. An ephemeral or missing source cannot be approved from body-free Quarantine metadata and must be safely resubmitted. Approval applies to one exact finding and content revision, not a whole note, field name, detector family, or pattern. Other findings remain independently enforced, and content or material rule-semantic changes invalidate the decision.

The machine-local audit record contains only operation and finding identities, Project, safe locator, content identity, keyed suspect fingerprint, risk category, detector rule identity and compatibility version, decision, controlled reason, timestamp, human provenance, and invalidation state. It contains no suspect value or excerpt. An active exact-revision decision has no arbitrary expiry; invalidated or source-unavailable audit metadata defaults to 180 calendar days.

Safety exceptions do not silently migrate to another machine. The destination re-evaluates content and may require another explicit human decision. No action authorizes a real credential, disables a detector globally, or creates a broad allowlist.
