---
status: accepted
---

# Keep Shadow observational and non-blocking

After an official Shadow window starts, changes to the installed candidate,
installation identity, MemStore configuration, managed Hooks, executable
program, or retrieval profile are recorded in `observedChanges`. They do not
invalidate the window, reset its start time, or block Gate 6 eligibility once
the seven-calendar-day minimum is met.

The persisted Shadow lifecycle contains only `active` and `completed` states.
The `shadow migrate-identity` and `shadow accept-program-change` commands and
their implementation are removed. Existing historical `invalidated` rows are
converted to `completed` during migration, while the current active window and
its original timing remain unchanged.

This makes Shadow evidence easier to interpret: Review sees what changed and
judges whether the collected evidence is sufficient. Shadow status itself no
longer turns implementation maintenance into an experiment reset workflow.
