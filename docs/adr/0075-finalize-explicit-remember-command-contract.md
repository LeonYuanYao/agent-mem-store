---
status: accepted
---

# Finalize the explicit remember command contract

The canonical explicit-capture surface is:

```text
memstore remember assert
  [--scope project|global]
  [--text <content> | --stdin | --file <path>]
  [--startup auto|always|never]
  [--preview] [--json]

memstore remember extract
  [--scope project|global]
  --from <current-turn|current-session|turn:<id>|file:<path>|selection:<id>>
  [--startup auto|always|never]
  [--preview] [--wait [seconds]] [--json]
```

`assert` requires exactly one content input and creates a Direct Human Assertion without Luna meaning rewrite. `extract` requires one normalized source selector, enters the durable Luna pipeline, and creates Agent-derived Candidates. Project and `startup: auto` are the defaults. Global scope must be explicit, and ambiguous natural-language intent routes to `extract`.

`--wait` is available only for `extract`, defaults to 120 seconds when present without a value, and may accept an explicit positive bounded timeout. Timeout ends the caller's wait but never cancels durable background work. It is mutually exclusive with the zero-mutation `--preview` contract in ADR-0074.

`--json` emits a versioned stable envelope. Accepted non-preview work reports an operation or Memory identity, resolved scope, authority, current state, and next inspection command. Canonical operation states are `completed`, `queued`, `retrying`, `waiting_verification`, `conflict`, `quarantined`, `blocked_secret`, `dead_letter`, and `failed`. A state is an observation of durable current state, not an assertion that pending work completed.

`$memstore-remember` is a thin router over these commands. It may pass through explicit options and resolve adapter-safe turn or selection identities, but it cannot change authority, scope authorization, preview semantics, durable processing, or state meanings.
