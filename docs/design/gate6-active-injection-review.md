# Gate 6 Active Injection Review

Status: accepted and implemented; Full Cutover remains separately gated.

## Discovered gap

The managed Codex Hooks carry `MEMSTORE_INJECTION_MODE=shadow`, and the cutover
rehearsal replaces that value with `active`, but the lightweight Hook entrypoint
does not read the mode or return Memory context. Changing the managed Hook text
therefore cannot activate injection. The rehearsal proves reversible file
changes, not working production recall.

Codex requires `SessionStart` and `UserPromptSubmit` command Hooks to return
`hookSpecificOutput.hookEventName` plus `hookSpecificOutput.additionalContext`.
The protocol is documented in the official
[Codex Hooks reference](https://learn.chatgpt.com/docs/hooks).

## Recommended boundary

Keep capture in the existing lightweight Hook process and add one local
foreground-retrieval endpoint to the existing persistent Worker:

1. The Worker owns a Unix-domain socket under Machine-local Runtime Data and
   sets its mode to `0600`.
2. The Worker reuses the already loaded E5-base q8 adapter. It does not spawn a
   model or load Transformers for each Hook invocation.
3. After durable capture, an active `SessionStart` or `UserPromptSubmit` Hook
   sends a bounded request containing the resolved Project identity, Session
   identity, prompt, and existing bounded retrieval signals.
4. The Worker runs the accepted deterministic pack preparation and returns only
   the bounded rendered pack and Receipt identity.
5. The Hook renders the official event-specific `additionalContext` JSON.
6. Connection failure, malformed output, Worker unavailability, or the accepted
   automatic deadline returns no context and continues the Codex turn.

The socket protocol is local-only, versioned, length-bounded, one-request per
connection, and never exposes Candidate, Secret, Vault body, or unrestricted
cross-Project access. Shadow continues using the asynchronous evaluator; active
mode uses the foreground endpoint so the same ranking and budget code remains
the single implementation.

## Why not the smaller alternatives

- Loading E5 inside each Hook process violates the 500-millisecond boundary on
  cold starts and duplicates model lifecycle code.
- Lexical-only active recall would make production materially different from
  the E5-backed Shadow evidence and reduce the accuracy the user prioritized.
- A SQLite request queue cannot provide bounded foreground latency while the
  Worker is awaiting long Luna operations unless a concurrent request endpoint
  still exists.
- A second retrieval LaunchAgent adds another model owner, lifecycle, health
  surface, and installation artifact without improving isolation over a socket
  owned by the existing Worker.

## Required evidence before Full Cutover

- contract tests for exact Codex `SessionStart` and `UserPromptSubmit` output;
- socket ownership, permissions, stale-socket recovery, request-size limits,
  project binding, malformed-message handling, and shutdown cleanup;
- active-mode end-to-end tests with the real Hook process and persistent
  retrieval server;
- p50/p95/p99 measurements that include capture, IPC, E5 query embedding,
  ranking, Receipt commit, serialization, and Hook response;
- Worker-down and deadline fault tests proving empty fail-open output;
- exact cutover preview and byte-exact rollback rehearsal;
- verification on a new Session plus one supported existing Session.

Repository implementation and Worker endpoint activation do not authorize a
live Hook-mode change or Full Cutover.

## Implementation evidence

- The real Codex Hook entrypoint returns exact event-specific
  `hookSpecificOutput.additionalContext` for both supported events and fails open
  when the Worker is absent.
- The socket is `0600`, rejects malformed and oversized requests, refuses a
  second live owner, recovers a dead socket, removes itself on shutdown, and
  binds selection to the requested Project plus Global scope.
- A foreground request reserves the captured event and completes its evaluation
  ledger row, preventing the asynchronous Shadow evaluator from replaying the
  event or restarting its Context Epoch.
- The first real E5-base q8 end-to-end benchmark exposed a client dependency
  leak: SessionStart/UserPromptSubmit p50 was about 396/399 milliseconds and
  UserPromptSubmit p99 was 501 milliseconds. Splitting the client from the
  server-side pack/tokenizer graph fixed the root cause.
- The repeated 30+30 process benchmark now includes Hook process startup,
  Project resolution, Capture, IPC, resident E5 query embedding, deterministic
  ranking and packing, Receipt persistence, and JSON serialization. SessionStart
  measured p50/p95/p99 86.7/93.6/94.1 milliseconds; UserPromptSubmit measured
  91.8/99.8/101.2 milliseconds.

The persistent Worker currently owns the endpoint, but managed Hooks remain in
Shadow mode. Full Cutover and the live Hook-mode change still require the Gate 6
approval defined by the Spec.
