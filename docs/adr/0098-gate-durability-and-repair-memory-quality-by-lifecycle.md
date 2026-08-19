---
status: accepted
---

# Gate durability and repair Memory quality by lifecycle

Agent-derived content must pass durability classification whenever Luna semantic
assessment is required. A supported claim is not automatically durable:
`task_local`, `transient`, and `no_retention` are rejected before Canonical
promotion; `uncertain` or legacy-unclassified durability remains outside normal
recall. The deterministic Promotion Gate owns this decision for every evidence
class instead of applying it only to explicit-user evidence.

Canonical promotion may validate a compact representation without another model
call only when it is an exact copy of the Memory body, fits the compact token
limit, and contains every separately declared condition, exclusion, and
preserved negation. All other compact representations remain unvalidated until
background representation work can prove them lossless. A paginated quality
operation audits existing Agent-derived Memory and can repair only this exact,
lossless subset with a new traceable revision. Preview is the default operating
practice before applying a Vault-wide backfill.

Non-exact compact repair uses two independent asynchronous Luna stages around a
local gate. The first stage generates a compact candidate from the frozen body
and Semantic Contract. Local code rejects schema, token, sensitivity, structured
anchor, revision, or content-identity violations. A separate Luna assessment
then judges whether the surviving candidate preserves the core claim, scope,
certainty, conditions, exclusions, and negations without adding a claim. Only a
successful independent assessment can publish a new representation revision.
Backfill is paginated and restartable, prioritizes Active frequently eligible
Memory, and never delays foreground capture or recall.

Incorrectness and staleness are not one deletion rule. Governance distinguishes:

- intrinsically non-durable operational probes, exact-response checks, temporary
  progress, and current run state, which Agent governance may archive;
- time-sensitive claims whose current truth is uncertain, which remain visible
  as review or verification debt rather than being silently rewritten;
- contradicted or replaced Agent-derived claims, which are archived with a
  successor and provenance;
- materially duplicate Agent-derived claims, which retain one
  condition-preserving successor and merge supporting provenance;
- Human-authored claims, which only receive Review Suggestions unless the human
  explicitly authorizes a revision.

Quality audit signals are diagnostic, not truth. Deterministic indicators such
as operational provenance, runtime identities, temporal status wording, and an
unvalidated compact can select work for Luna or human review, but cannot by
themselves rewrite or delete knowledge. Scheduled Weekly and Monthly Governance
applies the same lifecycle decisions incrementally, so the one-time historical
cleanup and steady-state anti-corruption path use the same rules.

The quality pipeline is explicitly enabled with `quality start` after a dry-run
review. It scans incrementally, queues at most a small page per idle Worker
iteration, retries each Luna stage at most six times, and repeats weekly after a
complete pass. `quality status` exposes pending, rejected, blocked, stale, and
completed work. `quality compact-backfill --preview` remains the bounded
selection inspection command.

Agent-derived `review_due` Memory stays available to explicit search and
identity reads with a warning, but is excluded from SessionStart and per-prompt
automatic packs. Governance can mark this state without claiming the Memory is
false. Human-authored Memory continues to use Review Suggestions instead.

Semantic duplicate governance uses the active precomputed embedding index only
as a candidate generator. Pairs must share exact scope and applicability before
they are queued. A separate Luna decision classifies equivalent, directional
subsumption, conflict, unrelated, or uncertain. Only current completed decisions
are exposed to Governance as reviewed duplicate clusters; similarity alone never
authorizes merge, supersession, conflict handling, or archival. Discovery is
incremental and repeats weekly or whenever the active index changes.
