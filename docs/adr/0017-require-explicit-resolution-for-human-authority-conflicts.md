---
status: accepted
---

# Require explicit resolution for human-authority conflicts

MemStore distinguishes an intentional replacement from a new assertion that merely happens to conflict with existing Human-authored Memory. An update or replace operation that explicitly identifies an existing Memory authorizes a successor revision: the new Direct Human Assertion becomes active, and the previous Memory is archived with its provenance and successor identity. This is a traceable revision, not an in-place silent overwrite.

A generic remember operation does not carry implicit replacement authority. When its Direct Human Assertion materially conflicts with existing Human-authored Memory, MemStore durably retains the new assertion in Human Conflict state but excludes it from normal recall. The initiating command presents one bounded resolution surface: keep the existing Memory, adopt the new assertion as its successor, or distinguish the applicability conditions so both can remain valid. This exceptional interaction is limited to the user's explicit memory operation and does not create an approval requirement for background capture or governance.

A user edit to the same Memory identity directly in Obsidian is itself an authoritative revision and requires no additional MemStore confirmation. MemStore detects the content change, retains revision provenance, and rebuilds affected derived state. Sensitivity containment still applies, so authoritative editing does not permit Secret Content to enter indexes, Luna, injection, logs, or other prohibited paths.

Agent-derived conflicts continue through the ordinary non-blocking candidate lifecycle. They cannot overwrite Human-authored Memory and do not interrupt an active Agent conversation merely because background governance found them.
