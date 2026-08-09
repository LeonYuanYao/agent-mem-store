# Outcome 7 retrieval and Shadow preparation

Status: implementation candidate awaiting human review. Nothing in this outcome
installs MemStore, writes a real Vault, changes global Codex configuration, or
injects a computed pack into a live Session.

## Published retrieval state

The index builder snapshots active Canonical catalog identities, reads the
matching current revisions, derives exact metadata and searchable text, embeds
each retrieval unit, and writes a normalized float32 sidecar plus manifest into
a staging directory. It verifies the sidecar checksum, atomically renames the
directory, and only then changes the active SQLite index revision in one
transaction. A failed build leaves the prior completed revision selected.

The first implementation intentionally uses FTS5 plus an exact flat-vector scan.
There is no ANN service and no network call in foreground Recall. Adapter
identity includes model identity, Transformers adapter version, artifact hash,
dimensions, and normalization so incompatible indexes cannot be mixed.

## Explicit Recall

Search defaults to the resolved Project plus Global Memory. It combines FTS5
and, when the exact active adapter is available, semantic ranking. Search pages
default to 16 identities and a 4,096 rendered-token target. Opaque cursors bind
the normalized query, scope, caller, ranking policy, and active index revision;
a changed binding fails as stale instead of silently continuing another query.

Agents deepen by stable identity through compact, standard, or full reads,
provenance pages, and exactly one relationship hop per call. Retrieval chains
have no MemStore product hard limit. They emit a warning for every newly crossed
8,192-token band. Cross-Project Private content remains blocked. An
`irrelevant` report must reference a Receipt that proves the same caller
received that exact Memory revision; repeated reports are idempotent and
aggregate into a body-free Bad Case plus a bounded diagnostic bundle.

## Non-injected automatic packs

SessionStart and UserPromptSubmit return `mode: shadow` and `injected: false`.
They read only completed local derived state and never call Luna.

SessionStart uses validated compact text (at most 96 body tokens), then a
separately validated identity label (at most 48) for eligible higher-tier items.
It enforces 1,200 total tokens, a 600-token `startup: always` ceiling, 12 items,
and at most four identity fallbacks. Candidate buckets are paged from SQLite in
16-row keyset pages by effective priority and category. More pages are fetched
only while capacity remains and a bucket needs another candidate. Receipts
record examined rows, page count, omission count, up to 128 bounded omission
details, whether details were truncated, and the stop reason.

UserPromptSubmit uses current prompt plus bounded file, symbol, error, and
command signals. Deterministic code assigns `high`, `probable`, or `weak`; weak
items do not enter the pack. A semantic-only candidate must be the Top-1 result,
clear the strong-score threshold, and lead the second result by at least 0.02;
weaker semantic evidence participates only with lexical, applicability, or
structured-signal corroboration. Packing preserves compact breadth before optional
standard detail, admits at most two probable items, and enforces six items,
600 target tokens, and 1,024 hard tokens. One-hop adjacency is only a small
boost: the adjacent item must independently reach probable relevance. A Memory
revision appears at most once per Context Epoch. The epoch has an 8,192 soft
target and 12,288 hard cap, with the accepted stricter post-soft gate.

Definitively expired or not-yet-effective intervals are hard-filtered. The
automatic path stops optional semantic work at 300 ms, stops candidate paging
at 450 ms, and fails open with an empty pack when Runtime state is unavailable. The public result
uses an explicit `unrecorded` Receipt identity when SQLite failure makes durable
observability impossible; it never claims that such a Receipt was persisted.

## Embedding evidence and unresolved activation choice

The reproducible benchmark compares a lightweight multilingual MiniLM candidate
and a quality-oriented multilingual E5-base candidate over Chinese, English,
code, path, error, Git, Obsidian, and command queries. The current warm-cache
evidence is in `docs/evidence/outcome7-embedding-benchmark.json`; the first
download-inclusive observation is retained separately in
`docs/evidence/outcome7-embedding-benchmark-cold.json`.

| Candidate | Artifact | Warm load | RSS delta | Query p95 | Recall@1 / @3 | Semantic-only gate recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| MiniLM student L6 q8 | 28.7 MB | 839 ms | 182 MB | 1.96 ms | 44.4% / 88.9% | 0% |
| multilingual-e5-base q8 | 295.3 MB | 927 ms | 1.12 GB | 4.43 ms | 100% / 100% | 88.9% |

These are directional synthetic results from ten documents and nine positive
queries, not Shadow workload proof. E5-base also produces materially higher
cosine scores for unrelated negative queries, so its score thresholds must be
calibrated with its selected adapter profile. The proposed score-and-margin gate
rejected all three negative queries for both candidates, but that sample is too
small to claim a production false-positive rate. Outcome 7 therefore does not
freeze either artifact checksum, activate either adapter, or claim automatic
semantic readiness. Human review must choose one of: use E5-base as the Shadow
candidate and review calibrated thresholds, request another balanced model
benchmark, or keep automatic retrieval lexical-only while retaining semantic
explicit Recall as experimental.

## Executable evidence

- atomic index publish and prior-index preservation:
  `tests/integration/retrieval/index-build.test.ts`, `tests/fault/index.test.ts`;
- scope, hybrid search, query-bound cursors, validity, and identity deep reads:
  `tests/contract/recall.test.ts`;
- progressive reads, chain warnings, one-hop relationships, and Bad Cases:
  `tests/contract/progressive-recall.test.ts`;
- pack ranking, pagination, Context Epoch limits, Receipts, and no injection:
  `tests/integration/retrieval/shadow-packs.test.ts`;
- unavailable Runtime/index and slow-semantic fail-open behavior:
  `tests/fault/automatic-retrieval.test.ts`.

## Review boundary

Approval of Outcome 7 may select a benchmark direction and authorize Outcome 8
repository work. It does not authorize a model download outside temporary
benchmark state, a real index build, Hook/MCP/Skill installation, live Shadow
operation, automatic injection, or replacement of Codex native memory.
