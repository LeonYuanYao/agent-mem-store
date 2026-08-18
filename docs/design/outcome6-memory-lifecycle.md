# Outcome 6 Luna and Memory lifecycle

Status: implementation candidate pending human review. This document does not
authorize Outcome 7, installation, a real Vault write, or global integration.

## Implemented boundaries

- Hooks remain model-free. Capture Events are claimed by a background Worker,
  grouped into durable Batches, and sent only to `gpt-5.6-luna` through an
  ephemeral, read-only Codex process with a minimal environment and file/shell,
  browser, app, and plugin tools disabled. There is no fallback model.
- Batch distillation, multi-Batch Session consolidation, and semantic evidence
  assessment each use a versioned task and a strict JSON output schema. Every
  cited evidence identity must have been supplied by MemStore.
- Multi-Batch results are intermediate data. A completed one-Batch Session may
  create Candidates directly; a completed multi-Batch Session creates
  Candidates only from its structured consolidation result. Active Turns wait
  for `Stop` and checkpoint only at 64 events or 512 KiB; resumed Sessions
  consolidate only the closed Batch ordinals after their durable cursor.
- Luna operations are leased, idempotent, retryable, and health-observable.
  Authentication, model, and configuration failures become visibly
  unavailable. Transient failures use bounded exponential backoff. Local
  processing failures remain separate from model health.
- Agent-derived output enters `waiting` Candidate state and is absent from
  normal recall. Deterministic evidence checks and, where required, a durable
  Luna semantic assessment feed a local Promotion Gate. Only the local gate can
  commit `promote`, `merge`, `wait`, `conflict`, `reject`, or `expire`.
  Explicit-user evidence must bind a checksum-verified `UserPromptSubmit`
  Capture Event. Full-path promotion consumes only a persisted assessment bound
  to a durable Luna operation for that Candidate; callers cannot inject an
  in-memory `supported` result.
  Code/configuration evidence is re-read and checked against its current Git
  revision and content identity where Git applies; non-Git files bind an exact
  content identity within the registered Project root. Human references must bind the current Human
  revision and content identity. Captured command evidence must still match its
  checksum-verified Capture Event. Generic intact `PostToolUse` evidence that
  lacks deterministic command fields requires a durable supported Luna
  assessment that cites the exact event before it can contribute to promotion.
- Global automatic promotion requires a supported semantic assessment and two
  independent Project, source, and content identities. A copied upstream
  assertion therefore does not gain independence merely by appearing under two
  Projects. Memory Echoes, truncated sources, and
  integrity-ambiguous evidence do not add support or independence. Explicit
  Global authorization bypasses only the Project count. It is a statement-bound
  Human operation with a source identity, not a boolean. Private content cannot
  become Global automatically and needs an authorization that explicitly covers
  Private sensitivity.
- External tests, builds, deployments, or privileged actions are represented
  by durable Verification Requests. Outcome 6 never executes a proposed
  verification action.
- Direct Human Assertions preserve the exact assertion body and write with
  Human-authored authority with an operation and source identity. Potential
  conflicts receive a durable Luna conflict assessment, but no Luna result
  resolves the conflict. The Human can keep the existing assertion, adopt the
  new assertion as successor, or distinguish applicability. Adoption is limited
  to a Memory named by that conflict. Only explicit adoption archives the
  predecessor and links a successor, and the highest sensitivity is preserved.
- Candidate retention is based on materially new evidence time. Ordinary
  waiting Candidates default to 90 days; high-value, conflict, and open
  Verification Request cases default to 180 days. A Candidate must have had a
  successful governance opportunity before it can expire. Crossing the deadline
  creates an expiration obligation even during Luna downtime; a later successful
  governance recheck is required before expiration can commit.
  Materially new verified evidence advances the Candidate evidence generation,
  cancels an old expiration obligation, clears the prior successful-evaluation
  marker, and makes older Luna assessments unusable.
- Expiration records its governance decision before removing the Candidate
  body. The body-free Tombstone defaults to a configurable 180 days. Same or
  echoed evidence is deduplicated; materially new independent evidence can
  create a linked new Candidate. Tombstones with active governance references
  are not purged. Waiting for an unavailable Luna assessment is not recorded as
  a successful governance opportunity and therefore cannot authorize expiration.
- Controlled high-value tags can affect validation depth, priority, and
  retention, but never truth or authority. Luna must give one bounded reason and
  evidence references per proposed tag; the local gate checks both. Session
  burst, Project rolling change, cold-start, and tag-dominance anomalies are
  diagnostic only and need two adjacent evaluation windows to become persistent.
  Session-burst data is restricted to its evaluation window, so one historical
  burst cannot become persistent merely because catch-up evaluates another window.

## Claim-to-evidence map

| Claim | Executable evidence |
| --- | --- |
| Luna uses the exact isolated Codex contract, strict schemas, versioned tasks, evidence binding, and no fallback | `tests/contract/luna-adapter.test.ts` |
| Model health, backoff, explicit retry, and two-signal recovery are body-free and queryable | `tests/fault/luna-health.test.ts` |
| Long Turns coalesce until Stop or a bounded checkpoint, and resumed Sessions consolidate only new closed ranges without resending raw evidence | `tests/e2e/distillation.test.ts` |
| A transient failure retains work, and replay after a persisted result does not reinvoke Luna or duplicate a Candidate | `tests/fault/luna-worker.test.ts` |
| Candidates stay outside recall until the Promotion Gate; evidence, Global, Echo, Verification Request, retention, and Tombstone rules hold | `tests/integration/lifecycle/candidate-lifecycle.test.ts` |
| Durable semantic assessment feeds the deterministic Promotion Gate, including generic tool evidence and historical backfill | `tests/integration/lifecycle/semantic-worker.test.ts` |
| Direct Human Assertions retain exact text, isolate conflicts, and create traceable successors only on explicit replacement | `tests/integration/lifecycle/human-assertion.test.ts` |
| Durable conflict assessment informs review without rewriting text or resolving Human authority | `tests/integration/lifecycle/human-conflict-worker.test.ts` |
| High-value anomalies remain diagnostic and require two evaluations to become persistent | `tests/integration/lifecycle/high-value-anomaly.test.ts` |

## Known bounded gaps

- No Worker, Hook, scheduler, CLI, MCP server, notifier, or Skill is installed.
  Outcome 6 exposes repository-local seams only.
- The authenticated local Codex model catalog currently exposes
  `gpt-5.6-luna`, but this implementation review does not make a live model call.
  A live invocation remains an operational check before Shadow installation.
- Discovery of the bounded existing-Memory set to assess across a large corpus
  needs the Outcome 7 retrieval index. Given that set, Outcome 6 durably runs the
  conflict assessment and enforces isolation and explicit resolution.
- A Session without a captured `SessionEnd` retains durable Batch results but
  does not finalize them into Candidates yet. Missed-run and abandoned-Session
  catch-up belongs to scheduled governance in Outcome 9.
- Explicit Human replacement spans two CAS-protected Canonical writes. A failure
  between predecessor archival and successor creation is visible and retryable,
  but it is not a cross-file atomic transaction. The later durable command path
  must expose this state rather than claim completion.
- Retrieval, compact-pack validation, embeddings, ranking, Injection Receipts,
  and Shadow Pack preparation remain Outcome 7 work.
